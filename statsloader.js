const statsElements = {
    empty: document.getElementById("statsEmpty"),
    content: document.getElementById("statsContent"),
    favoritePiece: document.getElementById("favPiece"),
    favoritePieceSymbol: document.getElementById("favPieceSymbol"),
    rockUses: document.getElementById("rockUses"),
    paperUses: document.getElementById("paperUses"),
    scissorUses: document.getElementById("scissorUses"),
    favoriteSquare: document.getElementById("favoriteSquare"),
    favoriteOpening: document.getElementById("favoriteOpening"),
    replacementRate: document.getElementById("replacementRate"),
    finishedGames: document.getElementById("finishedGames"),
    datasetSummary: document.getElementById("datasetSummary"),
    datasetNote: document.getElementById("datasetNote"),
    exportButton: document.getElementById("exportData"),
    resetButton: document.getElementById("resetLearning"),
    actionStatus: document.getElementById("statsActionStatus")
}

const PIECE_DETAILS = {
    rock: {label: "Rock", symbol: "\u2617"},
    paper: {label: "Paper", symbol: "\uD83D\uDDCB"},
    scissors: {label: "Scissors", symbol: "\u2702"}
}
const CELL_LABELS = [
    "top left", "top middle", "top right",
    "middle left", "center", "middle right",
    "bottom left", "bottom middle", "bottom right"
]
const EMPTY_VALUE = "\u2014"
const playerDataApi = typeof globalThis !== "undefined"
    ? globalThis.RpsxoPlayerData
    : null

let latestSummary = null
let actionInProgress = false

function safeCount(value) {
    const numericValue = Number(value)
    return Number.isFinite(numericValue) && numericValue > 0
        ? Math.floor(numericValue)
        : 0
}

function normalisePieceName(piece) {
    const value = typeof piece === "string" ? piece.toLowerCase() : ""
    if (value === "r" || value === "rock" || piece === "\u2617") return "rock"
    if (value === "p" || value === "paper" || piece === "\uD83D\uDDCB") return "paper"
    if (value === "s" || value === "scissors" || value === "scissor" || piece === "\u2702") {
        return "scissors"
    }
    return null
}

function pieceCounts(summary) {
    return {
        rock: safeCount(summary?.pieces?.rock),
        paper: safeCount(summary?.pieces?.paper),
        scissors: safeCount(summary?.pieces?.scissors)
    }
}

function favoritePieces(summary, counts) {
    const suppliedFavorites = Array.isArray(summary?.favoritePieces)
        ? summary.favoritePieces.map(normalisePieceName).filter(Boolean)
        : []
    const uniqueFavorites = [...new Set(suppliedFavorites)]
    if (uniqueFavorites.length > 0) return uniqueFavorites

    const highestCount = Math.max(counts.rock, counts.paper, counts.scissors)
    if (highestCount === 0) return []
    return Object.keys(counts).filter(piece => counts[piece] === highestCount)
}

function joinFavoriteLabels(labels, emptyLabel = EMPTY_VALUE) {
    if (labels.length === 0) return emptyLabel
    if (labels.length > 2) return "No clear favorite"
    return labels.join(" + ")
}

function formatFavoriteSquares(value) {
    if (!Array.isArray(value)) return EMPTY_VALUE
    const labels = [...new Set(value)]
        .filter(cell => Number.isInteger(cell) && CELL_LABELS[cell])
        .map(cell => CELL_LABELS[cell])
    return joinFavoriteLabels(labels)
}

function formatFavoriteOpenings(value) {
    if (!Array.isArray(value)) return EMPTY_VALUE
    const labels = []
    const seen = new Set()
    value.forEach(opening => {
        const piece = normalisePieceName(opening?.piece)
        const cell = Number(opening?.cell)
        if (!piece || !Number.isInteger(cell) || !CELL_LABELS[cell]) return
        const label = `${PIECE_DETAILS[piece].label} in ${CELL_LABELS[cell]}`
        if (seen.has(label)) return
        seen.add(label)
        labels.push(label)
    })
    return joinFavoriteLabels(labels)
}

function formatReplacementRate(value) {
    if (value === null || value === undefined) return EMPTY_VALUE
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) return EMPTY_VALUE
    const percentage = Math.round(Math.min(1, Math.max(0, numericValue)) * 100)
    return `${percentage}%`
}

function pluralized(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`
}

function trainingSummary(summary) {
    const decisions = safeCount(summary?.datasetDecisions)
    const games = safeCount(summary?.datasetGames)
    const analyzed = safeCount(summary?.analyzedDecisions)
    const base = `${pluralized(decisions, "move")} remembered across ${pluralized(games, "game")}`
    return analyzed > 0 ? `${base}; ${pluralized(analyzed, "move")} analyzed` : base
}

function persistentStorageAvailable(storageMode) {
    if (typeof storageMode !== "string") return true
    const mode = storageMode.toLowerCase()
    return !mode.includes("memory") && !mode.includes("temporary") &&
        !mode.includes("unavailable") && !mode.includes("disabled")
}

function updateDataNote(summary) {
    if (!statsElements.datasetNote) return
    statsElements.datasetNote.textContent = persistentStorageAvailable(summary?.storageMode)
        ? "Saved only in this browser. No model is training yet."
        : "Browser storage is unavailable, so this session's data may not be saved."
}

function updateActionButtons(summary) {
    const hasLearningData = safeCount(summary?.datasetGames) > 0 ||
        safeCount(summary?.datasetDecisions) > 0
    if (statsElements.exportButton) {
        statsElements.exportButton.disabled = actionInProgress || !playerDataApi ||
            typeof playerDataApi.exportData !== "function"
    }
    if (statsElements.resetButton) {
        statsElements.resetButton.disabled = actionInProgress || !hasLearningData
    }
}

function renderStats(summary) {
    latestSummary = summary && typeof summary === "object" ? summary : {}
    const counts = pieceCounts(latestSummary)
    const totalMoves = safeCount(latestSummary.moves)
    const hasStats = totalMoves > 0 || counts.rock + counts.paper + counts.scissors > 0 ||
        safeCount(latestSummary.gamesStarted) > 0 ||
        safeCount(latestSummary.datasetGames) > 0 || safeCount(latestSummary.datasetDecisions) > 0

    if (statsElements.empty) statsElements.empty.hidden = hasStats
    if (statsElements.content) statsElements.content.hidden = !hasStats
    if (statsElements.datasetSummary) {
        statsElements.datasetSummary.textContent = trainingSummary(latestSummary)
    }
    updateDataNote(latestSummary)
    updateActionButtons(latestSummary)
    if (!hasStats) {
        return
    }

    const favorites = favoritePieces(latestSummary, counts)
    if (statsElements.favoritePiece) {
        statsElements.favoritePiece.textContent = favorites.length > 0
            ? favorites.map(piece => PIECE_DETAILS[piece].label).join(" + ")
            : "No favorite yet"
    }
    if (statsElements.favoritePieceSymbol) {
        statsElements.favoritePieceSymbol.textContent = favorites
            .map(piece => PIECE_DETAILS[piece].symbol)
            .join(" ")
        if (favorites.length > 1) statsElements.favoritePieceSymbol.classList.add("multiplePieces")
        else statsElements.favoritePieceSymbol.classList.remove("multiplePieces")
    }
    if (statsElements.rockUses) statsElements.rockUses.textContent = String(counts.rock)
    if (statsElements.paperUses) statsElements.paperUses.textContent = String(counts.paper)
    if (statsElements.scissorUses) statsElements.scissorUses.textContent = String(counts.scissors)
    if (statsElements.favoriteSquare) {
        statsElements.favoriteSquare.textContent = formatFavoriteSquares(latestSummary.favoriteCells)
    }
    if (statsElements.favoriteOpening) {
        statsElements.favoriteOpening.textContent = formatFavoriteOpenings(latestSummary.favoriteOpenings)
    }
    if (statsElements.replacementRate) {
        statsElements.replacementRate.textContent = formatReplacementRate(latestSummary.replacementRate)
    }
    if (statsElements.finishedGames) {
        statsElements.finishedGames.textContent = String(safeCount(latestSummary.gamesCompleted))
    }
}

function showUnavailable(message = "Your stats could not be loaded right now.") {
    latestSummary = null
    if (statsElements.empty) {
        statsElements.empty.hidden = false
        statsElements.empty.textContent = message
    }
    if (statsElements.content) statsElements.content.hidden = true
    if (statsElements.datasetNote) {
        statsElements.datasetNote.textContent = "Browser stats are unavailable right now."
    }
    if (statsElements.exportButton) statsElements.exportButton.disabled = true
    if (statsElements.resetButton) statsElements.resetButton.disabled = true
}

function showActionStatus(message) {
    if (statsElements.actionStatus) statsElements.actionStatus.textContent = message
}

function setActionInProgress(inProgress) {
    actionInProgress = inProgress
    updateActionButtons(latestSummary || {})
}

async function exportLearningData() {
    if (!playerDataApi || typeof playerDataApi.exportData !== "function") {
        showActionStatus("Export is unavailable right now.")
        return
    }

    setActionInProgress(true)
    showActionStatus("Preparing export...")
    try {
        const exportValue = await playerDataApi.exportData()
        const blob = new Blob([JSON.stringify(exportValue, null, 2)], {type: "application/json"})
        const downloadUrl = URL.createObjectURL(blob)
        const downloadLink = document.createElement("a")
        downloadLink.href = downloadUrl
        downloadLink.download = `rpsxo-training-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(downloadLink)
        downloadLink.click()
        downloadLink.remove()
        URL.revokeObjectURL(downloadUrl)
        showActionStatus("Training data exported.")
    } catch (error) {
        console.warn("Could not export RPSXO training data", error)
        showActionStatus("The export could not be created.")
    } finally {
        setActionInProgress(false)
    }
}

async function resetLearningData() {
    if (!playerDataApi || typeof playerDataApi.resetLearning !== "function") {
        showActionStatus("Reset is unavailable right now.")
        return
    }

    const decisionCount = safeCount(latestSummary?.datasetDecisions)
    if (typeof globalThis.confirm !== "function") {
        showActionStatus("Reset confirmation is unavailable right now.")
        return
    }
    const confirmation = globalThis.confirm(
        `Forget ${pluralized(decisionCount, "training move")}? Your overall stats will stay.`
    )
    if (!confirmation) return

    setActionInProgress(true)
    showActionStatus("Resetting training data...")
    try {
        const updatedSummary = await playerDataApi.resetLearning()
        renderStats(updatedSummary)
        showActionStatus("Training data reset. Your overall stats are still here.")
    } catch (error) {
        console.warn("Could not reset RPSXO training data", error)
        showActionStatus("Training data could not be reset.")
    } finally {
        setActionInProgress(false)
    }
}

async function loadStats() {
    if (!playerDataApi || typeof playerDataApi.ready !== "function" ||
        typeof playerDataApi.getSummary !== "function") {
        showUnavailable()
        return
    }

    try {
        await playerDataApi.ready()
        renderStats(await playerDataApi.getSummary())
    } catch (error) {
        console.warn("Could not load RPSXO stats", error)
        showUnavailable()
    }
}

if (statsElements.exportButton) {
    statsElements.exportButton.addEventListener("click", exportLearningData)
}
if (statsElements.resetButton) {
    statsElements.resetButton.addEventListener("click", resetLearningData)
}

void loadStats()
