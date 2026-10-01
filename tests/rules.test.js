const assert = require("node:assert/strict")
const test = require("node:test")

const rules = require("../rules")

const ROCK = rules.ROCK
const PAPER = rules.PAPER
const SCISSORS = rules.SCISSORS
const EMPTY_BOARD = Array(rules.BOARD_CELLS).fill("")

test("piece vocabulary round-trips through codes, names and symbols", () => {
    assert.deepEqual(rules.PIECES, ["", ROCK, PAPER, SCISSORS])
    assert.deepEqual(rules.MOVES, [ROCK, PAPER, SCISSORS])
    assert.deepEqual(rules.PIECE_NAMES, ["", "rock", "paper", "scissors"])

    for (const code of [1, 2, 3]) {
        assert.equal(rules.pieceName(rules.PIECES[code]), rules.PIECE_NAMES[code])
        assert.equal(rules.pieceCode(rules.PIECES[code]), code)
    }

    // Legacy records stored either a symbol or a short name for the same piece.
    assert.equal(rules.pieceName(ROCK), "rock")
    assert.equal(rules.pieceName("rock"), "rock")
    assert.equal(rules.pieceName("R"), "rock")
    assert.equal(rules.pieceName("scissor"), "scissors")
    assert.equal(rules.pieceName("lizard"), null)
    assert.equal(rules.pieceCode("rock"), 0)
    assert.equal(rules.pieceCode(null), 0)
})

test("each piece beats exactly one other piece, which is what replaces it", () => {
    for (const piece of rules.MOVES) {
        const beaten = rules.BEATS[piece]
        assert.ok(rules.MOVES.includes(beaten))

        // In RPSXO you may only overwrite a cell with the piece that defeats
        // what is already there, so the replacement is the inverse of BEATS.
        const replacing = rules.replacingPiece(piece)
        assert.equal(rules.BEATS[replacing], piece)
        assert.equal(rules.replacingPiece(replacing) !== piece, true)
    }

    assert.equal(rules.BEATS[ROCK], SCISSORS)
    assert.equal(rules.BEATS[PAPER], ROCK)
    assert.equal(rules.BEATS[SCISSORS], PAPER)
    assert.equal(rules.replacingPiece(ROCK), PAPER)
    assert.equal(rules.replacingCode(1), 2)
    assert.equal(rules.replacingCode(3), 1)
})

test("the board codec is a lossless two-bit-per-cell encoding", () => {
    const board = [ROCK, PAPER, SCISSORS, "", SCISSORS, "", PAPER, "", ROCK]
    const state = rules.encodeBoard(board)
    assert.equal(Number.isInteger(state), true)
    assert.ok(state >= 0 && state < (1 << 18))
    assert.deepEqual(rules.decodeBoard(state), board)

    assert.equal(rules.encodeBoard(EMPTY_BOARD), 0)
    assert.deepEqual(rules.decodeBoard(0), EMPTY_BOARD)
    assert.equal(rules.codeAt(state, 0), 1)
    assert.equal(rules.codeAt(state, 2), 3)

    assert.throws(() => rules.encodeBoard([ROCK]), /exactly 9 cells/)
    assert.throws(() => rules.encodeBoard(["bad", ...EMPTY_BOARD.slice(1)]), /Unknown RPSXO piece/)
    assert.throws(() => rules.decodeBoard(-1), /Invalid encoded/)
    assert.throws(() => rules.decodeBoard(1 << 18), /Invalid encoded/)
})

test("winning lines are found from either a symbol board or an encoded state", () => {
    for (const line of rules.WIN_LINES) {
        const board = [...EMPTY_BOARD]
        for (const cell of line) board[cell] = ROCK
        assert.deepEqual(rules.winningLine(board), line)
        assert.equal(rules.winningLine(rules.encodeBoard(board)).join(","), line.join(","))
        assert.equal(rules.boardHasWin(board), true)
    }

    // Ownership is disregarded, so a line of identical pieces wins whoever
    // placed it.
    const twoRocksOnePaper = [ROCK, PAPER, ROCK, "", "", "", "", "", ""]
    assert.equal(rules.boardHasWin(twoRocksOnePaper), false)
    assert.equal(rules.winningLine(EMPTY_BOARD), null)
    assert.equal(rules.boardHasWin(EMPTY_BOARD), false)
})

test("skill is clamped, rounded and normalised onto a 0..1 difficulty curve", () => {
    assert.equal(rules.clampSkill(0), rules.MIN_SKILL)
    assert.equal(rules.clampSkill(5000), rules.MAX_SKILL)
    assert.equal(rules.clampSkill(300.4), 300)
    assert.equal(rules.clampSkill(300.6), 301)
    assert.equal(rules.clampSkill("nonsense"), rules.DEFAULT_SKILL)
    assert.equal(rules.clampSkill(undefined), rules.DEFAULT_SKILL)

    assert.equal(rules.normaliseSkill(rules.MIN_SKILL), 0)
    assert.equal(rules.normaliseSkill(rules.MAX_SKILL), 1)
    assert.equal(rules.normaliseSkill(500), (500 - 1) / 999)
    // Out-of-range and unparseable values collapse to the ends of the curve.
    assert.equal(rules.normaliseSkill(-5), 0)
    assert.equal(rules.normaliseSkill(9999), 1)
    assert.equal(rules.normaliseSkill("nonsense"), 0)
})

test("a normal script exposes the rules without a module system", () => {
    const {readFileSync} = require("node:fs")
    const path = require("node:path")
    const vm = require("node:vm")

    const source = readFileSync(path.join(__dirname, "..", "rules.js"), "utf8")
    const context = {module: undefined, require: undefined}
    vm.createContext(context)
    vm.runInContext(source, context)

    assert.equal(context.RpsxoRules.ROCK, ROCK)
    assert.equal(context.RpsxoRules.encodeBoard(EMPTY_BOARD), 0)
})