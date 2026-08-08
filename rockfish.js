/*
 * Rockfish: a depth-limited negamax engine for RPSXO.
 *
 * A board is encoded with two bits per cell:
 *   0 = empty, 1 = rock, 2 = paper, 3 = scissors.
 * Paper replaces rock, scissors replaces paper, and rock replaces scissors.
 */
(function initialiseRockfish(globalScope) {
    "use strict"

    const WIN_LINES = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],
        [0, 4, 8],
        [2, 4, 6]
    ]
    const LINES_BY_CELL = Array.from({length: 9}, () => [])
    WIN_LINES.forEach(line => line.forEach(cell => LINES_BY_CELL[cell].push(line)))

    const PIECES = ["", "☗", "🗋", "✂"]
    const PIECE_CODES = {"☗": 1, "🗋": 2, "✂": 3}
    const CELL_ORDER = [4, 0, 2, 6, 8, 1, 3, 5, 7]
    const BOARD_TRANSFORMS = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8],
        [6, 3, 0, 7, 4, 1, 8, 5, 2],
        [8, 7, 6, 5, 4, 3, 2, 1, 0],
        [2, 5, 8, 1, 4, 7, 0, 3, 6],
        [2, 1, 0, 5, 4, 3, 8, 7, 6],
        [6, 7, 8, 3, 4, 5, 0, 1, 2],
        [0, 3, 6, 1, 4, 7, 2, 5, 8],
        [8, 5, 2, 7, 4, 1, 6, 3, 0]
    ]

    const STATE_COUNT = 1 << 18
    const MAX_DEPTH = 10
    const WIN_SCORE = 10000
    const SCORE_LIMIT = 20000
    const CACHE_NONE = 0
    const CACHE_EXACT = 1
    const CACHE_LOWER_BOUND = 2
    const CACHE_UPPER_BOUND = 3
    const SEARCH_TIMEOUT = Object.freeze({name: "SearchTimeout"})

    // The score cache is safe across turns and games: RPSXO has no piece ownership,
    // so a state's value depends only on the board and remaining search depth.
    const cacheSize = STATE_COUNT * (MAX_DEPTH + 1)
    const cachedScores = new Int16Array(cacheSize)
    const cachedScoreTypes = new Uint8Array(cacheSize)
    const canonicalCache = new Int32Array(STATE_COUNT)
    const evaluationCache = new Int16Array(STATE_COUNT)
    const evaluationReady = new Uint8Array(STATE_COUNT)
    const principalMoves = new Int8Array(STATE_COUNT)
    canonicalCache.fill(-1)
    principalMoves.fill(-1)

    let searchDeadline = Infinity
    let searchedNodes = 0
    let cacheHits = 0

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value))
    }

    function now() {
        if (typeof performance !== "undefined" && performance.now) {
            return performance.now()
        }
        return Date.now()
    }

    function nextPiece(piece) {
        return piece === 3 ? 1 : piece + 1
    }

    function pieceAt(state, cell) {
        return (state >> (cell * 2)) & 3
    }

    function encodeBoard(board) {
        if (!Array.isArray(board) || board.length !== 9) {
            throw new Error("A RPSXO board must contain exactly 9 cells")
        }

        let state = 0
        board.forEach((piece, cell) => {
            if (piece === "") return
            const code = PIECE_CODES[piece]
            if (!code) throw new Error(`Unknown RPSXO piece: ${piece}`)
            state |= code << (cell * 2)
        })
        return state
    }

    function decodeBoard(state) {
        return Array.from({length: 9}, (_, cell) => PIECES[pieceAt(state, cell)])
    }

    function encodeMove(cell, piece) {
        return (cell * 4) + piece
    }

    function decodeMove(moveCode) {
        return [Math.floor(moveCode / 4), PIECES[moveCode & 3]]
    }

    function applyMove(state, moveCode) {
        const cell = Math.floor(moveCode / 4)
        const piece = moveCode & 3
        const shift = cell * 2
        return (state & ~(3 << shift)) | (piece << shift)
    }

    function isLegalMove(state, moveCode) {
        const cell = Math.floor(moveCode / 4)
        const piece = moveCode & 3
        if (cell < 0 || cell > 8 || piece < 1 || piece > 3) return false
        const currentPiece = pieceAt(state, cell)
        return currentPiece === 0 || piece === nextPiece(currentPiece)
    }

    function isWinningMove(state, moveCode) {
        const cell = Math.floor(moveCode / 4)
        const piece = moveCode & 3
        const newState = applyMove(state, moveCode)

        return LINES_BY_CELL[cell].some(line => (
            pieceAt(newState, line[0]) === piece &&
            pieceAt(newState, line[1]) === piece &&
            pieceAt(newState, line[2]) === piece
        ))
    }

    function isWinningState(state) {
        return WIN_LINES.some(line => {
            const piece = pieceAt(state, line[0])
            return piece !== 0 &&
                pieceAt(state, line[1]) === piece &&
                pieceAt(state, line[2]) === piece
        })
    }

    function legalMoves(state, preferredMove = -1) {
        const result = []
        if (isLegalMove(state, preferredMove)) result.push(preferredMove)

        for (const cell of CELL_ORDER) {
            const currentPiece = pieceAt(state, cell)
            if (currentPiece === 0) {
                for (let piece = 1; piece <= 3; piece += 1) {
                    const moveCode = encodeMove(cell, piece)
                    if (moveCode !== preferredMove) result.push(moveCode)
                }
            } else {
                const moveCode = encodeMove(cell, nextPiece(currentPiece))
                if (moveCode !== preferredMove) result.push(moveCode)
            }
        }
        return result
    }

    function canonicalState(state) {
        const cached = canonicalCache[state]
        if (cached !== -1) return cached

        let bestState = STATE_COUNT
        for (const transform of BOARD_TRANSFORMS) {
            // Rotating all three piece types leaves the rules unchanged. For a
            // given spatial transform, the smallest colour rotation maps the
            // most-significant occupied cell to rock (1).
            let anchorPiece = 0
            for (let targetCell = 8; targetCell >= 0; targetCell -= 1) {
                anchorPiece = pieceAt(state, transform[targetCell])
                if (anchorPiece !== 0) break
            }
            const colourShift = anchorPiece === 0 ? 0 : (4 - anchorPiece) % 3

            let transformedState = 0
            for (let targetCell = 0; targetCell < 9; targetCell += 1) {
                let piece = pieceAt(state, transform[targetCell])
                if (piece !== 0) piece = ((piece - 1 + colourShift) % 3) + 1
                transformedState |= piece << (targetCell * 2)
            }
            bestState = Math.min(bestState, transformedState)
        }

        canonicalCache[state] = bestState
        return bestState
    }

    function evaluateState(state) {
        const canonical = canonicalState(state)
        if (evaluationReady[canonical]) return evaluationCache[canonical]

        let immediateWins = 0
        for (const moveCode of legalMoves(state)) {
            if (isWinningMove(state, moveCode)) immediateWins += 1
        }

        let linePotential = 0
        for (const line of WIN_LINES) {
            const counts = [0, 0, 0, 0]
            line.forEach(cell => { counts[pieceAt(state, cell)] += 1 })
            const strongestGroup = Math.max(counts[1], counts[2], counts[3])
            if (strongestGroup === 2) linePotential += 6
            else if (strongestGroup === 1) linePotential += 1
        }

        // This is deliberately far below WIN_SCORE: tactics may guide a
        // horizon position but can never outrank a proven win.
        const score = Math.min(800, (immediateWins * 40) + linePotential)
        evaluationCache[canonical] = score
        evaluationReady[canonical] = 1
        return score
    }

    function checkDeadline(force = false) {
        if ((force || (searchedNodes & 1023) === 0) && now() >= searchDeadline) {
            throw SEARCH_TIMEOUT
        }
    }

    function negamax(state, depth, alpha, beta) {
        searchedNodes += 1
        checkDeadline()
        if (depth === 0) return evaluateState(state)

        const canonical = canonicalState(state)
        const cacheIndex = (depth * STATE_COUNT) + canonical
        const originalAlpha = alpha
        const originalBeta = beta
        const cachedType = cachedScoreTypes[cacheIndex]

        if (cachedType !== CACHE_NONE) {
            cacheHits += 1
            const cachedScore = cachedScores[cacheIndex]
            if (cachedType === CACHE_EXACT) return cachedScore
            if (cachedType === CACHE_LOWER_BOUND) alpha = Math.max(alpha, cachedScore)
            if (cachedType === CACHE_UPPER_BOUND) beta = Math.min(beta, cachedScore)
            if (alpha >= beta) return cachedScore
        }

        const preferredMove = principalMoves[state]
        const moves = legalMoves(state, preferredMove)

        // No continuation can beat winning on this move.
        for (const moveCode of moves) {
            if (isWinningMove(state, moveCode)) {
                const score = WIN_SCORE + depth
                cachedScores[cacheIndex] = score
                cachedScoreTypes[cacheIndex] = CACHE_EXACT
                principalMoves[state] = moveCode
                return score
            }
        }

        let bestScore = -SCORE_LIMIT
        let bestMove = moves[0]

        for (const moveCode of moves) {
            const childState = applyMove(state, moveCode)
            const score = -negamax(childState, depth - 1, -beta, -alpha)
            if (score > bestScore) {
                bestScore = score
                bestMove = moveCode
            }
            alpha = Math.max(alpha, bestScore)
            if (alpha >= beta) break
        }

        let scoreType = CACHE_EXACT
        if (bestScore <= originalAlpha) scoreType = CACHE_UPPER_BOUND
        else if (bestScore >= originalBeta) scoreType = CACHE_LOWER_BOUND

        cachedScores[cacheIndex] = bestScore
        cachedScoreTypes[cacheIndex] = scoreType
        principalMoves[state] = bestMove
        return bestScore
    }

    function analyzeAtDepth(state, depth, rootOrder) {
        const preferred = rootOrder && rootOrder.length ? rootOrder[0] : -1
        let moves = legalMoves(state, preferred)
        if (rootOrder && rootOrder.length) {
            const order = new Map(rootOrder.map((moveCode, index) => [moveCode, index]))
            moves.sort((a, b) => (order.get(a) ?? rootOrder.length) - (order.get(b) ?? rootOrder.length))
        }

        const analysis = []
        for (const moveCode of moves) {
            checkDeadline(true)
            const score = isWinningMove(state, moveCode)
                ? WIN_SCORE + depth
                : -negamax(applyMove(state, moveCode), depth - 1, -SCORE_LIMIT, SCORE_LIMIT)
            analysis.push({moveCode, move: decodeMove(moveCode), score})
        }

        analysis.sort((a, b) => b.score - a.score || a.moveCode - b.moveCode)
        return analysis
    }

    function skillToDepth(skill) {
        const normalisedSkill = (clamp(Number(skill) || 1, 1, 1000) - 1) / 999
        return clamp(1 + Math.round(9 * normalisedSkill * normalisedSkill), 1, MAX_DEPTH)
    }

    function skillToTimeLimit(skill) {
        const normalisedSkill = (clamp(Number(skill) || 1, 1, 1000) - 1) / 999
        return 25 + Math.round(425 * normalisedSkill * normalisedSkill)
    }

    function analyzePosition(board, options = {}) {
        const state = encodeBoard(board)
        if (isWinningState(state)) {
            throw new Error("Cannot analyze a game that has already been won")
        }

        const requestedDepth = options.maxDepth ?? skillToDepth(options.skill ?? 300)
        const targetDepth = clamp(Math.trunc(requestedDepth), 1, MAX_DEPTH)
        const timeLimitMs = options.timeLimitMs ?? Infinity
        const iterative = options.iterative ?? Number.isFinite(timeLimitMs)
        const startedAt = now()

        searchDeadline = Number.isFinite(timeLimitMs) ? startedAt + Math.max(1, timeLimitMs) : Infinity
        searchedNodes = 0
        cacheHits = 0

        let completedDepth = 0
        let completedAnalysis = null
        let rootOrder = null
        const firstDepth = iterative ? 1 : targetDepth

        for (let depth = firstDepth; depth <= targetDepth; depth += 1) {
            try {
                const nextAnalysis = analyzeAtDepth(state, depth, rootOrder)
                completedAnalysis = nextAnalysis
                completedDepth = depth
                rootOrder = nextAnalysis.map(move => move.moveCode)
                if (!iterative) break
            } catch (error) {
                if (error !== SEARCH_TIMEOUT) throw error
                break
            }
        }

        // Depth one is tiny and gives a safe legal response even on an unusually
        // slow device whose deadline expired during worker startup.
        if (!completedAnalysis) {
            searchDeadline = Infinity
            completedAnalysis = analyzeAtDepth(state, 1, null)
            completedDepth = 1
        }

        return {
            analysis: completedAnalysis.map(({move, score}) => ({move, score})),
            depth: completedDepth,
            targetDepth,
            nodes: searchedNodes,
            cacheHits,
            durationMs: Math.round((now() - startedAt) * 100) / 100
        }
    }

    function clearCaches() {
        cachedScores.fill(0)
        cachedScoreTypes.fill(CACHE_NONE)
        canonicalCache.fill(-1)
        evaluationCache.fill(0)
        evaluationReady.fill(0)
        principalMoves.fill(-1)
    }

    const api = {
        MAX_DEPTH,
        WIN_SCORE,
        analyzePosition,
        applyMove,
        canonicalState,
        clearCaches,
        decodeBoard,
        decodeMove,
        encodeBoard,
        encodeMove,
        evaluateState,
        isLegalMove,
        isWinningMove,
        isWinningState,
        legalMoves,
        skillToDepth,
        skillToTimeLimit
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api
    }

    if (globalScope && typeof globalScope.postMessage === "function") {
        globalScope.onmessage = function onRockfishMessage(event) {
            if (!event.data || event.data.type !== "playMove") return

            try {
                const skill = clamp(Number(event.data.skill) || 1, 1, 1000)
                const result = analyzePosition(event.data.board, {
                    skill,
                    timeLimitMs: skillToTimeLimit(skill),
                    iterative: true
                })
                globalScope.postMessage({requestId: event.data.requestId, ...result})
            } catch (error) {
                globalScope.postMessage({
                    requestId: event.data.requestId,
                    error: error instanceof Error ? error.message : "Rockfish search failed"
                })
            }
        }
    }
})(typeof self !== "undefined" ? self : null)
