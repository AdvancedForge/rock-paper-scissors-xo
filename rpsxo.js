const cells = document.querySelectorAll(".cell")
const restartXBtn = document.getElementById("restartX")
const restartOBtn = document.getElementById("restartO")
const turnTracker = document.getElementById("turnTracker")
const selectRock = document.getElementById("selectRock")
const selectPaper = document.getElementById("selectPaper")
const selectScissors = document.getElementById("selectScissors")
const singleplayerBtn = document.getElementById("singleplayer")
const twoplayerBtn = document.getElementById("twoplayer")
const botSkillBar = document.getElementById("botSkill")
const botSkillDisplay = document.getElementById("botSkillP")

// Keep source files ASCII-only so a host with a bad charset cannot corrupt the
// values shared by the page and the worker.
const ROCK = "\u2617"
const PAPER = "\uD83D\uDDCB"
const SCISSORS = "\u2702"
const winLines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
]
const moves = [ROCK, PAPER, SCISSORS]
const beatsDict = {[ROCK]: SCISSORS, [PAPER]: ROCK, [SCISSORS]: PAPER}
const PROVEN_SCORE = 9000
const HEURISTIC_SCORE_PER_RANK = 40
const MAX_HEURISTIC_GAP_RANKS = 4
const useInlineRockfish = typeof location !== "undefined" && location.protocol === "file:"

let gamemode = "singleplayer"
let turn = "X"
let gameOver = false
let selectedMove = ROCK
let botSkill = Number(botSkillBar?.value ?? 300)
let rockfish = null
let pendingAiRequest = null
let aiRequestSequence = 0
let aiMoveTimer = null
let aiWatchdogTimer = null
let statsReady = Promise.resolve()

let user = {
    "rating": 100,
    "bestRating": 100,
    "ratingHistory": [100],
    "WLR": [0, 0], "WLA": [0, 0],
    "R": 0, "P": 0, "S": 0,
    "R0": 0, "R1": 0, "R2": 0, "R3": 0, "R4": 0, "R5": 0, "R6": 0, "R7": 0, "R8": 0,
    "P0": 0, "P1": 0, "P2": 0, "P3": 0, "P4": 0, "P5": 0, "P6": 0, "P7": 0, "P8": 0,
    "S0": 0, "S1": 0, "S2": 0, "S3": 0, "S4": 0, "S5": 0, "S6": 0, "S7": 0, "S8": 0
}

async function save() {
    if (typeof localforage === "undefined") return
    try {
        await localforage.setItem("user", user)
    } catch (error) {
        console.warn("Could not save RPSXO stats", error)
    }
}

async function load() {
    if (typeof localforage === "undefined") return
    try {
        const storedUser = await localforage.getItem("user")
        if (storedUser) user = storedUser
        else await save()
    } catch (error) {
        console.warn("Could not load RPSXO stats", error)
    }
}

function boardArray() {
    return Array.from(cells).map(cell => cell.textContent)
}

function boardKey(board = boardArray()) {
    return board.join("|")
}

function inlineRockfishEngine() {
    const engine = typeof globalThis !== "undefined" ? globalThis.Rockfish : null
    return engine && typeof engine.analyzePosition === "function" ? engine : null
}

function createRockfishWorker() {
    // Chromium does not allow a file:// page to load an external Worker. The
    // same engine is available in-page for downloaded copies of the game.
    if (useInlineRockfish) return null
    if (typeof Worker === "undefined") return null

    try {
        const worker = new Worker("rockfish.js")
        worker.onmessage = event => handleRockfishMessage(event, worker)
        worker.onerror = event => handleRockfishError(event, worker)
        worker.onmessageerror = event => handleRockfishError(event, worker)
        return worker
    } catch (error) {
        console.error("Could not start Rockfish", error)
        return null
    }
}

function cancelAiSearch() {
    if (aiMoveTimer !== null) {
        clearTimeout(aiMoveTimer)
        aiMoveTimer = null
    }
    if (aiWatchdogTimer !== null) {
        clearTimeout(aiWatchdogTimer)
        aiWatchdogTimer = null
    }
    pendingAiRequest = null
    aiRequestSequence += 1
    if (rockfish) rockfish.terminate()
    rockfish = createRockfishWorker()
}

function scheduleAiMove() {
    if (aiMoveTimer !== null) clearTimeout(aiMoveTimer)
    aiMoveTimer = setTimeout(() => {
        aiMoveTimer = null
        aiMove()
    }, 0)
}

function handleRockfishMessage(event, sourceWorker) {
    if (sourceWorker !== rockfish) return
    const request = pendingAiRequest
    if (!request) return

    const data = event?.data
    if (!data) {
        pendingAiRequest = null
        clearAiWatchdog()
        return playFallbackAiMove()
    }
    if (data.requestId !== request.id) return
    if (gamemode !== "singleplayer" || turn !== "O" || gameOver || boardKey() !== request.boardKey) {
        pendingAiRequest = null
        clearAiWatchdog()
        return
    }

    pendingAiRequest = null
    clearAiWatchdog()
    if (data.error || !Array.isArray(data.analysis) || data.analysis.length === 0) {
        console.error(data.error || "Rockfish returned no legal moves")
        return playFallbackAiMove()
    }

    const chosenMove = skillBasedMovePick(
        data.analysis,
        request.skill,
        data.previousAnalysis,
        data.depthBlend
    )
    if (!chosenMove || !Array.isArray(chosenMove.move)) return playFallbackAiMove()

    const [cellIndex, piece] = chosenMove.move
    if (!playMove(cells[cellIndex], piece)) playFallbackAiMove()
}

function handleRockfishError(event, sourceWorker) {
    if (sourceWorker !== rockfish) return
    if (event?.preventDefault) event.preventDefault()
    if (!pendingAiRequest) return

    console.error("Rockfish worker failed", event)
    pendingAiRequest = null
    clearAiWatchdog()
    if (rockfish) rockfish.terminate()
    rockfish = createRockfishWorker()
    playFallbackAiMove()
}

function clearAiWatchdog() {
    if (aiWatchdogTimer === null) return
    clearTimeout(aiWatchdogTimer)
    aiWatchdogTimer = null
}

function startAiWatchdog(requestId) {
    clearAiWatchdog()
    aiWatchdogTimer = setTimeout(() => {
        aiWatchdogTimer = null
        if (!pendingAiRequest || pendingAiRequest.id !== requestId) return
        console.error("Rockfish search timed out")
        pendingAiRequest = null
        if (rockfish) rockfish.terminate()
        rockfish = createRockfishWorker()
        playFallbackAiMove()
    }, 2000)
}

function cellClicked(event) {
    if (gameOver || (turn === "O" && gamemode === "singleplayer")) return

    const playedPiece = selectedMove
    if (!playMove(event.currentTarget, playedPiece)) return

    const moveToStat = {[ROCK]: "R", [PAPER]: "P", [SCISSORS]: "S"}
    void statsReady.then(() => {
        user[moveToStat[playedPiece]] += 1
        return save()
    })
}

function playMove(cell, piece = selectedMove) {
    if (gameOver || !cell || !moves.includes(piece)) return false
    if (cell.textContent && beatsDict[piece] !== cell.textContent) return false

    cell.textContent = piece
    if (findWin()) {
        endGame()
        return true
    }

    turn = turn === "X" ? "O" : "X"
    if (turn === "O" && gamemode === "singleplayer") {
        turnTracker.textContent = "O is thinking\u2026"
        scheduleAiMove()
    } else {
        turnTracker.textContent = `${turn}'s turn`
    }
    return true
}

function findWin() {
    return boardHasWin(boardArray())
}

function boardHasWin(board) {
    return winLines.some(line => {
        const firstPiece = board[line[0]]
        return firstPiece && firstPiece === board[line[1]] && firstPiece === board[line[2]]
    })
}

function endGame() {
    turnTracker.textContent = `${turn} wins!`
    gameOver = true
    pendingAiRequest = null
}

function restart(start) {
    cancelAiSearch()
    cells.forEach(cell => { cell.textContent = "" })
    gameOver = false
    turn = start
    turnTracker.textContent = `${start}'s turn`
    if (turn === "O" && gamemode === "singleplayer") {
        turnTracker.textContent = "O is thinking\u2026"
        scheduleAiMove()
    }
}

function legalAiMoves(board) {
    const outcomes = []
    board.forEach((piece, cellIndex) => {
        if (piece) {
            outcomes.push([cellIndex, beatsDict[beatsDict[piece]]])
        } else {
            moves.forEach(move => outcomes.push([cellIndex, move]))
        }
    })
    return outcomes
}

function playFallbackAiMove() {
    if (gamemode !== "singleplayer" || turn !== "O" || gameOver) return
    const board = boardArray()
    const analysis = legalAiMoves(board).map(move => {
        const [cellIndex, piece] = move
        const nextBoard = [...board]
        nextBoard[cellIndex] = piece

        let score = 0
        if (boardHasWin(nextBoard)) {
            score = PROVEN_SCORE
        } else if (legalAiMoves(nextBoard).some(reply => {
            const replyBoard = [...nextBoard]
            replyBoard[reply[0]] = reply[1]
            return boardHasWin(replyBoard)
        })) {
            score = -PROVEN_SCORE
        }
        return {move, score}
    })
    const chosenMove = skillBasedMovePick(analysis, botSkill)
    if (!chosenMove) return
    const [cellIndex, piece] = chosenMove.move
    playMove(cells[cellIndex], piece)
}

function runInlineRockfish(board, request) {
    const engine = inlineRockfishEngine()
    if (!engine) {
        pendingAiRequest = null
        return playFallbackAiMove()
    }

    try {
        const result = engine.analyzePosition(board, {
            skill: request.skill,
            timeLimitMs: engine.skillToTimeLimit(request.skill),
            iterative: true
        })
        handleRockfishMessage({data: {requestId: request.id, ...result}}, null)
    } catch (error) {
        console.error("In-page Rockfish failed", error)
        pendingAiRequest = null
        playFallbackAiMove()
    }
}

function aiMove() {
    if (gamemode !== "singleplayer" || turn !== "O" || gameOver) return
    if (pendingAiRequest) return

    const board = boardArray()
    const inlineEngine = useInlineRockfish ? inlineRockfishEngine() : null
    if (!rockfish && !inlineEngine) return playFallbackAiMove()

    const request = {
        id: ++aiRequestSequence,
        boardKey: boardKey(board),
        skill: botSkill
    }
    pendingAiRequest = request
    if (!rockfish) return runInlineRockfish(board, request)

    startAiWatchdog(request.id)
    try {
        rockfish.postMessage({
            type: "playMove",
            requestId: request.id,
            board,
            turn,
            skill: request.skill
        })
    } catch (error) {
        handleRockfishError(error, rockfish)
    }
}

function normalisedBotSkill(skill) {
    const numericSkill = Math.min(1000, Math.max(1, Number(skill) || 1))
    return (numericSkill - 1) / 999
}

function outcomeBand(score) {
    if (score >= PROVEN_SCORE) return 1
    if (score <= -PROVEN_SCORE) return -1
    return 0
}

function analyzedMoveScore(move) {
    return typeof move?.score === "number" && Number.isFinite(move.score)
        ? move.score
        : null
}

function isAnalyzedMoveCandidate(move) {
    return Array.isArray(move?.move) &&
        Number.isInteger(move.move[0]) && move.move[0] >= 0 && move.move[0] < cells.length &&
        moves.includes(move.move[1]) && analyzedMoveScore(move) !== null
}

function rankedAnalyzedMoves(analyzedMoves) {
    if (!Array.isArray(analyzedMoves) || analyzedMoves.length === 0) return []

    const seenMoveKeys = new Set()
    return analyzedMoves.map((move, index) => (
        {index, move, score: analyzedMoveScore(move)}
    )).filter(candidate => isAnalyzedMoveCandidate(candidate.move))
        .sort((first, second) => second.score - first.score || first.index - second.index)
        .filter(candidate => {
            const key = analyzedMoveKey(candidate.move)
            if (seenMoveKeys.has(key)) return false
            seenMoveKeys.add(key)
            return true
        })
}

function rankedMoveProbabilities(analyzedMoves, skill) {
    if (!Array.isArray(analyzedMoves) || analyzedMoves.length === 0) return []

    const normalisedSkill = normalisedBotSkill(skill)
    const continuation = Math.cbrt(1 - normalisedSkill)
    const rankedMoves = rankedAnalyzedMoves(analyzedMoves)
    if (rankedMoves.length === 0) return []

    // A geometric distribution gives every rank some probability below skill
    // 1000. Exact score ties share the mass of all ranks occupied by that tie,
    // so symmetric moves remain equally likely without their count swamping a
    // better or worse score group.
    const weights = Array(analyzedMoves.length).fill(0)
    let rank = 0
    let previousGroupScore = null
    for (let groupStart = 0; groupStart < rankedMoves.length;) {
        let groupEnd = groupStart + 1
        while (groupEnd < rankedMoves.length &&
            rankedMoves[groupEnd].score === rankedMoves[groupStart].score) {
            groupEnd += 1
        }

        const groupSize = groupEnd - groupStart
        const groupScore = rankedMoves[groupStart].score
        if (previousGroupScore !== null &&
            outcomeBand(previousGroupScore) === 0 && outcomeBand(groupScore) === 0) {
            const heuristicGapRanks = Math.min(
                MAX_HEURISTIC_GAP_RANKS,
                Math.floor((previousGroupScore - groupScore) / HEURISTIC_SCORE_PER_RANK)
            )
            rank += Math.max(0, heuristicGapRanks)
        }

        let groupWeight = 0
        for (let offset = 0; offset < groupSize; offset += 1) {
            groupWeight += Math.pow(continuation, rank + offset)
        }
        for (let index = groupStart; index < groupEnd; index += 1) {
            weights[rankedMoves[index].index] = groupWeight / groupSize
        }
        rank += groupSize
        previousGroupScore = groupScore
        groupStart = groupEnd
    }

    // Search scores have three qualitatively different bands: a proven win,
    // an unresolved heuristic value, and a proven loss. As skill rises, ensure
    // Rockfish increasingly chooses from the best available outcome band while
    // retaining ranked variety inside that band.
    const bestOutcomeBand = outcomeBand(rankedMoves[0].score)
    const bestBandMoves = rankedMoves.filter(candidate => outcomeBand(candidate.score) === bestOutcomeBand)
    const bestBandIndexes = new Set(bestBandMoves.map(candidate => candidate.index))
    const bestBandWeight = bestBandMoves.reduce((sum, candidate) => (
        sum + weights[candidate.index]
    ), 0)
    const otherBandWeight = rankedMoves.reduce((sum, candidate) => (
        bestBandIndexes.has(candidate.index) ? sum : sum + weights[candidate.index]
    ), 0)

    // Skill controls how much Rockfish insists on the best known outcome band.
    // The remaining mass respects how many legal alternatives exist: one safe
    // move among twenty losing moves is therefore easier to miss than one safe
    // move among two. Skill 1 stays uniform and skill 1000 stays exact.
    const uniformBestBandShare = bestBandMoves.length / rankedMoves.length
    const targetOtherBandProbability = (1 - uniformBestBandShare) * (1 - normalisedSkill)
    const targetBestBandProbability = 1 - targetOtherBandProbability
    const probabilities = weights.map((weight, index) => {
        if (bestBandIndexes.has(index)) {
            return bestBandWeight > 0
                ? targetBestBandProbability * (weight / bestBandWeight)
                : 0
        }
        return otherBandWeight > 0
            ? targetOtherBandProbability * (weight / otherBandWeight)
            : 0
    })

    const totalProbability = probabilities.reduce((sum, probability) => sum + probability, 0)
    return totalProbability > 0
        ? probabilities.map(probability => probability / totalProbability)
        : probabilities
}

function analyzedMoveKey(move) {
    return Array.isArray(move?.move) ? `${move.move[0]}|${move.move[1]}` : null
}

function moveSelectionProbabilities(analyzedMoves, skill, previousAnalysis = null, depthBlend = 1) {
    const currentProbabilities = rankedMoveProbabilities(analyzedMoves, skill)
    const blend = typeof depthBlend === "number" && Number.isFinite(depthBlend)
        ? Math.min(1, Math.max(0, depthBlend))
        : 1
    if (!Array.isArray(previousAnalysis) || previousAnalysis.length === 0 ||
        blend >= 1) {
        return currentProbabilities
    }

    const previousProbabilities = rankedMoveProbabilities(previousAnalysis, skill)
    const canonicalCurrentIndexes = new Set(
        rankedAnalyzedMoves(analyzedMoves).map(candidate => candidate.index)
    )
    const previousByMove = new Map()
    previousAnalysis.forEach((move, index) => {
        const key = analyzedMoveKey(move)
        const probability = previousProbabilities[index]
        if (key !== null && probability > 0) {
            previousByMove.set(key, (previousByMove.get(key) || 0) + probability)
        }
    })

    const blended = currentProbabilities.map((probability, index) => {
        if (!canonicalCurrentIndexes.has(index)) return 0
        const previousProbability = previousByMove.get(analyzedMoveKey(analyzedMoves[index])) || 0
        return (blend * probability) + ((1 - blend) * previousProbability)
    })
    const totalProbability = blended.reduce((sum, probability) => sum + probability, 0)
    return totalProbability > 0
        ? blended.map(probability => probability / totalProbability)
        : currentProbabilities
}

function skillBasedMovePick(analyzedMoves, skill, previousAnalysis = null, depthBlend = 1) {
    const probabilities = moveSelectionProbabilities(
        analyzedMoves,
        skill,
        previousAnalysis,
        depthBlend
    )
    if (probabilities.length === 0) return null

    let cumulativeProbability = 0
    let fallbackIndex = -1
    const randomNumber = Math.random()
    for (let index = 0; index < analyzedMoves.length; index += 1) {
        if (probabilities[index] > 0) fallbackIndex = index
        cumulativeProbability += probabilities[index]
        if (randomNumber < cumulativeProbability) return analyzedMoves[index]
    }

    return fallbackIndex >= 0 ? analyzedMoves[fallbackIndex] : null
}

function changeSelection(newMove) {
    if (newMove === selectedMove) return
    const moveToButton = {[ROCK]: selectRock, [PAPER]: selectPaper, [SCISSORS]: selectScissors}
    moveToButton[selectedMove].classList.remove("selectedBtn")
    selectedMove = newMove
    moveToButton[selectedMove].classList.add("selectedBtn")
}

cells.forEach(cell => cell.addEventListener("click", cellClicked))

if (restartXBtn) restartXBtn.addEventListener("click", () => restart("X"))
if (restartOBtn) restartOBtn.addEventListener("click", () => restart("O"))

selectRock.addEventListener("click", () => changeSelection(ROCK))
selectPaper.addEventListener("click", () => changeSelection(PAPER))
selectScissors.addEventListener("click", () => changeSelection(SCISSORS))

if (singleplayerBtn) singleplayerBtn.addEventListener("click", () => {
    if (gamemode === "singleplayer") return
    twoplayerBtn.classList.remove("selectedBtn")
    gamemode = "singleplayer"
    singleplayerBtn.classList.add("selectedBtn")
    restart("X")
})

if (twoplayerBtn) twoplayerBtn.addEventListener("click", () => {
    if (gamemode === "twoplayer") return
    singleplayerBtn.classList.remove("selectedBtn")
    gamemode = "twoplayer"
    twoplayerBtn.classList.add("selectedBtn")
    restart("X")
})

if (botSkillBar) botSkillBar.addEventListener("input", function updateBotSkill() {
    botSkill = Number(this.value)
    botSkillDisplay.textContent = botSkill
})

if (botSkillDisplay) botSkillDisplay.textContent = botSkill
rockfish = createRockfishWorker()
statsReady = load()
