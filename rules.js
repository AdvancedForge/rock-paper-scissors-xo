/*
 * Shared RPSXO vocabulary.
 *
 * The board shell, the move-selection policy and the local player data all
 * need the same pieces, win lines and board codec. They live here so what gets
 * played, what gets recorded and what gets reported cannot drift apart.
 *
 * rockfish.js keeps its own copy of the board codec on purpose: it also runs
 * as a standalone Worker and as a plain file:// script, neither of which can
 * rely on a second file being loaded alongside it.
 */
(function initialiseRules(globalScope) {
    "use strict"

    // ASCII escapes keep the page/worker/storage contract independent of the
    // charset used by a host serving these classic scripts.
    const ROCK = "\u2617"
    const PAPER = "\uD83D\uDDCB"
    const SCISSORS = "\u2702"

    const BOARD_CELLS = 9
    const BITS_PER_CELL = 2
    const STATE_COUNT = 1 << (BOARD_CELLS * BITS_PER_CELL)

    const PIECE_ORDER = ["rock", "paper", "scissors"]
    // Indexed by piece code, where 0 means an empty cell.
    const PIECES = ["", ROCK, PAPER, SCISSORS]
    const PIECE_NAMES = ["", ...PIECE_ORDER]
    const PIECE_LABELS = ["", "Rock", "Paper", "Scissors"]
    const PIECE_CODES = {[ROCK]: 1, [PAPER]: 2, [SCISSORS]: 3}
    const MOVES = [ROCK, PAPER, SCISSORS]
    const BEATS = {[ROCK]: SCISSORS, [PAPER]: ROCK, [SCISSORS]: PAPER}
    const PIECE_DETAILS = Object.fromEntries(PIECE_ORDER.map((name, index) => [
        name,
        {label: PIECE_LABELS[index + 1], symbol: PIECES[index + 1]}
    ]))

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

    const MIN_SKILL = 1
    const MAX_SKILL = 1000
    const DEFAULT_SKILL = 300

    // Legacy localForage records and current summaries both appear in this
    // codebase's history, so accept a symbol, a piece code, or a short/full
    // name and answer with the canonical lowercase name.
    const PIECE_ALIASES = {
        r: "rock", rock: "rock",
        p: "paper", paper: "paper",
        s: "scissors", scissor: "scissors", scissors: "scissors"
    }

    function pieceCode(piece) {
        if (Number.isInteger(piece) && piece >= 1 && piece <= 3) return piece
        return PIECE_CODES[piece] || 0
    }

    function pieceName(piece) {
        const code = pieceCode(piece)
        if (code) return PIECE_NAMES[code]
        if (typeof piece !== "string") return null
        return PIECE_ALIASES[piece.toLowerCase()] || null
    }

    // Only one piece may legally replace another, and it is the one it beats.
    function replacingCode(code) {
        return code === 3 ? 1 : code + 1
    }

    function replacingPiece(piece) {
        return PIECES[replacingCode(pieceCode(piece))]
    }

    function codeAt(state, cell) {
        return (state >> (cell * BITS_PER_CELL)) & 3
    }

    function encodeBoard(board) {
        if (!Array.isArray(board) || board.length !== BOARD_CELLS) {
            throw new Error("A RPSXO board must contain exactly 9 cells")
        }

        let state = 0
        board.forEach((piece, cell) => {
            if (piece === "" || piece === null || piece === undefined || piece === 0) return
            const code = pieceCode(piece)
            if (!code) throw new Error("Unknown RPSXO piece")
            state |= code << (cell * BITS_PER_CELL)
        })
        return state
    }

    function decodeBoard(state) {
        if (!Number.isInteger(state) || state < 0 || state >= STATE_COUNT) {
            throw new Error("Invalid encoded RPSXO board")
        }
        return Array.from({length: BOARD_CELLS}, (_, cell) => PIECES[codeAt(state, cell)])
    }

    // Accepts either a symbol board or an already encoded state so callers do
    // not each decide which representation they happen to be holding.
    function winningLine(board) {
        const state = Array.isArray(board) ? encodeBoard(board) : board
        return WIN_LINES.find(line => {
            const code = codeAt(state, line[0])
            return code !== 0 && codeAt(state, line[1]) === code && codeAt(state, line[2]) === code
        }) || null
    }

    function boardHasWin(board) {
        return Boolean(winningLine(board))
    }

    function clampSkill(value) {
        const numeric = Number(value)
        if (!Number.isFinite(numeric)) return DEFAULT_SKILL
        return Math.min(MAX_SKILL, Math.max(MIN_SKILL, Math.round(numeric)))
    }

    function normaliseSkill(value) {
        const numeric = Math.min(MAX_SKILL, Math.max(MIN_SKILL, Number(value) || MIN_SKILL))
        return (numeric - MIN_SKILL) / (MAX_SKILL - MIN_SKILL)
    }

    const api = {
        BEATS,
        BOARD_CELLS,
        DEFAULT_SKILL,
        MAX_SKILL,
        MIN_SKILL,
        MOVES,
        PAPER,
        PIECE_CODES,
        PIECE_DETAILS,
        PIECE_LABELS,
        PIECE_NAMES,
        PIECES,
        ROCK,
        SCISSORS,
        WIN_LINES,
        boardHasWin,
        clampSkill,
        codeAt,
        decodeBoard,
        encodeBoard,
        normaliseSkill,
        pieceCode,
        pieceName,
        replacingCode,
        replacingPiece,
        winningLine
    }

    if (typeof module !== "undefined" && module.exports) module.exports = api
    if (globalScope) globalScope.RpsxoRules = api
})(typeof globalThis !== "undefined" ? globalThis : null)