/*
 * RPSXO board shell.
 *
 * Owns the DOM board, turn order, mode switching and the bridge to the
 * Rockfish engine. Game vocabulary comes from rules.js and move selection from
 * policy.js, so this file is only concerned with driving a game.
 */
const rules = (typeof globalThis !== "undefined" && globalThis.RpsxoRules) || null
const policy = (typeof globalThis !== "undefined" && globalThis.RpsxoPolicy) || null

const ROCK = rules.ROCK
const PAPER = rules.PAPER
const SCISSORS = rules.SCISSORS
const moves = rules.MOVES
const beatsDict = rules.BEATS
const boardHasWin = rules.boardHasWin
const winningLine = rules.winningLine
const skillBasedMovePick = policy.skillBasedMovePick
const normaliseSkill = rules.normaliseSkill

const AI_THINKING_TEXT = "O is thinking\u2026"
const AI_WATCHDOG_MS = 2000

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

const playerData = typeof globalThis !== "undefined"
    ? globalThis.RpsxoPlayerData
    : null

let gamemode = "singleplayer"
let turn = "X"
let gameOver = false
let selectedMove = ROCK
let botSkill = Number(botSkillBar?.value ?? rules.DEFAULT_SKILL)
let rockfish = null
let pendingAiRequest = null
let aiRequestSequence = 0
let aiMoveTimer = null
let aiWatchdogTimer = null
let gameStartingTurn = "X"

// Chromium does not allow a file:// page to load an external Worker, so a copy
// opened from disk runs the same engine in-page instead.
const useInlineRockfish = typeof location !== "undefined" && location.protocol === "file:"

function callPlayerData(method, payload) {
    if (!playerData || typeof playerData[method] !== "function") return
    try {
        const result = playerData[method](payload)
        if (result && typeof result.catch === "function") {
            void result.catch(error => console.warn("Could not update player data", error))
        }
    } catch (error) {
        console.warn("Could not update player data", error)
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

function resetRockfishWorker() {
    if (rockfish) rockfish.terminate()
    rockfish = createRockfishWorker()
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
    resetRockfishWorker()
}

function scheduleAiMove() {
    if (aiMoveTimer !== null) clearTimeout(aiMoveTimer)
    aiMoveTimer = setTimeout(() => {
        aiMoveTimer = null
        aiMove()
    }, 0)
}

function isAiTurn() {
    return gamemode === "singleplayer" && turn === "O" && !gameOver
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
    if (!isAiTurn() || boardKey() !== request.boardKey) {
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
    if (!playMove(cells[cellIndex], piece, {
        actor: "rockfish",
        source: sourceWorker ? "worker" : "inline",
        botSkill: request.skill
    })) {
        playFallbackAiMove()
    }
}

function handleRockfishError(event, sourceWorker) {
    if (sourceWorker !== rockfish) return
    if (event?.preventDefault) event.preventDefault()
    if (!pendingAiRequest) return

    console.error("Rockfish worker failed", event)
    pendingAiRequest = null
    clearAiWatchdog()
    resetRockfishWorker()
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
        resetRockfishWorker()
        playFallbackAiMove()
    }, AI_WATCHDOG_MS)
}

function cellClicked(event) {
    if (gameOver || (turn === "O" && gamemode === "singleplayer")) return

    const actor = gamemode === "singleplayer" ? "human" : `local_${turn.toLowerCase()}`
    playMove(event.currentTarget, selectedMove, {actor, source: "click"})
}

function playMove(cell, piece = selectedMove, moveContext = {}) {
    if (gameOver || !cell || !moves.includes(piece)) return false
    if (cell.textContent && beatsDict[piece] !== cell.textContent) return false

    const boardBefore = boardArray()
    const cellIndex = Array.from(cells).indexOf(cell)
    if (cellIndex < 0) return false
    const actor = moveContext.actor || (turn === "X" ? "human" : "rockfish")

    if (gamemode === "singleplayer") {
        callPlayerData("recordMove", {
            mode: gamemode,
            starter: gameStartingTurn,
            humanTurn: "X",
            turn,
            actor,
            source: moveContext.source || "unknown",
            boardBefore,
            cell: cellIndex,
            piece,
            botSkill: moveContext.botSkill ?? botSkill
        })
    }

    cell.textContent = piece
    const win = winningLine(boardArray())
    if (win) {
        endGame({
            winner: turn,
            winningPiece: piece,
            winningLine: win
        })
        return true
    }

    turn = turn === "X" ? "O" : "X"
    if (turn === "O" && gamemode === "singleplayer") {
        turnTracker.textContent = AI_THINKING_TEXT
        scheduleAiMove()
    } else {
        turnTracker.textContent = `${turn}'s turn`
    }
    return true
}

function endGame(result) {
    turnTracker.textContent = `${turn} wins!`
    gameOver = true
    pendingAiRequest = null
    if (gamemode === "singleplayer") callPlayerData("finishGame", result)
}

function restart(start, reason = "restart") {
    if (gamemode === "singleplayer") callPlayerData("abandonGame", reason)
    cancelAiSearch()
    cells.forEach(cell => { cell.textContent = "" })
    gameOver = false
    turn = start
    gameStartingTurn = start
    turnTracker.textContent = `${start}'s turn`
    if (turn === "O" && gamemode === "singleplayer") {
        turnTracker.textContent = AI_THINKING_TEXT
        scheduleAiMove()
    }
}

function legalAiMoves(board) {
    const outcomes = []
    board.forEach((piece, cellIndex) => {
        if (piece) {
            outcomes.push([cellIndex, rules.replacingPiece(piece)])
        } else {
            moves.forEach(move => outcomes.push([cellIndex, move]))
        }
    })
    return outcomes
}

// Used only when Rockfish cannot answer at all. Looks one reply deep for a
// proven win or a proven loss so the turn is never locked and a weak
// replacement still finishes the game legally.
function playFallbackAiMove() {
    if (!isAiTurn()) return
    const board = boardArray()
    const analysis = legalAiMoves(board).map(move => {
        const [cellIndex, piece] = move
        const nextBoard = [...board]
        nextBoard[cellIndex] = piece

        let score = 0
        if (boardHasWin(nextBoard)) {
            score = policy.PROVEN_SCORE
        } else if (legalAiMoves(nextBoard).some(reply => {
            const replyBoard = [...nextBoard]
            replyBoard[reply[0]] = reply[1]
            return boardHasWin(replyBoard)
        })) {
            score = -policy.PROVEN_SCORE
        }
        return {move, score}
    })
    const chosenMove = skillBasedMovePick(analysis, botSkill)
    if (!chosenMove) return
    const [cellIndex, piece] = chosenMove.move
    playMove(cells[cellIndex], piece, {actor: "rockfish", source: "fallback"})
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
    if (!isAiTurn() || pendingAiRequest) return

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
    restart("X", "mode_change")
})

if (twoplayerBtn) twoplayerBtn.addEventListener("click", () => {
    if (gamemode === "twoplayer") return
    callPlayerData("abandonGame", "mode_change")
    singleplayerBtn.classList.remove("selectedBtn")
    gamemode = "twoplayer"
    twoplayerBtn.classList.add("selectedBtn")
    restart("X", "mode_change")
})

if (botSkillBar) botSkillBar.addEventListener("input", function updateBotSkill() {
    botSkill = Number(this.value)
    botSkillDisplay.textContent = botSkill
})

if (botSkillDisplay) botSkillDisplay.textContent = botSkill
if (typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", () => {
        if (gamemode === "singleplayer") callPlayerData("abandonGame", "page_closed")
    })
}
rockfish = createRockfishWorker()
callPlayerData("ready")