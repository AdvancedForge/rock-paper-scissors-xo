const assert = require("node:assert/strict")
const {readFileSync} = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const engine = require("../rockfish")

const EMPTY_BOARD = Array(9).fill("")
const PIECES = ["☗", "🗋", "✂"]
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

function simpleNegamax(state, depth) {
    if (depth === 0) return engine.evaluateState(state)

    let bestScore = -20000
    for (const move of engine.legalMoves(state)) {
        const score = engine.isWinningMove(state, move)
            ? engine.WIN_SCORE + depth
            : -simpleNegamax(engine.applyMove(state, move), depth - 1)
        bestScore = Math.max(bestScore, score)
    }
    return bestScore
}

function simpleAnalysis(board, depth) {
    const state = engine.encodeBoard(board)
    return engine.legalMoves(state).map(moveCode => ({
        move: engine.decodeMove(moveCode),
        score: engine.isWinningMove(state, moveCode)
            ? engine.WIN_SCORE + depth
            : -simpleNegamax(engine.applyMove(state, moveCode), depth - 1)
    })).sort(compareAnalysis)
}

function compareAnalysis(first, second) {
    return JSON.stringify(first.move).localeCompare(JSON.stringify(second.move))
}

function sortedAnalysis(analysis) {
    return analysis.map(result => ({move: result.move, score: result.score})).sort(compareAnalysis)
}

test("board encoding round-trips all pieces", () => {
    const board = ["☗", "🗋", "✂", "", "✂", "☗", "", "🗋", ""]
    assert.deepEqual(engine.decodeBoard(engine.encodeBoard(board)), board)
})

test("legal move generation follows RPS replacement rules", () => {
    assert.equal(engine.legalMoves(engine.encodeBoard(EMPTY_BOARD)).length, 27)

    const board = ["☗", "", "", "", "", "", "", "", ""]
    const moves = engine.legalMoves(engine.encodeBoard(board)).map(engine.decodeMove)
    assert.equal(moves.length, 25)
    assert.deepEqual(moves.filter(move => move[0] === 0), [[0, "🗋"]])
})

test("all eight win lines work for all three pieces", () => {
    for (const line of WIN_LINES) {
        for (const piece of PIECES) {
            const board = Array(9).fill("")
            line.forEach(cell => { board[cell] = piece })
            assert.equal(engine.isWinningState(engine.encodeBoard(board)), true)
        }
    }
})

test("the engine always ranks an immediate win first", () => {
    const board = ["☗", "☗", "", "🗋", "", "", "", "", ""]
    const result = engine.analyzePosition(board, {maxDepth: 4})
    assert.deepEqual(result.analysis[0].move, [2, "☗"])
    assert.equal(result.analysis[0].score, engine.WIN_SCORE + 4)
})

test("cached alpha-beta values match a cache-free minimax reference", () => {
    const fixtures = [
        ["", "🗋", "☗", "🗋", "✂", "🗋", "", "🗋", "☗"],
        ["☗", "", "🗋", "", "✂", "", "", "☗", ""],
        ["✂", "🗋", "", "☗", "", "", "", "", ""]
    ]

    fixtures.forEach((board, fixtureIndex) => {
        const depth = fixtureIndex + 2
        engine.clearCaches()
        const actual = sortedAnalysis(engine.analyzePosition(board, {maxDepth: depth}).analysis)
        assert.deepEqual(actual, simpleAnalysis(board, depth))
    })
})

test("symmetric moves receive symmetric scores", () => {
    const board = ["", "🗋", "☗", "🗋", "✂", "🗋", "", "🗋", "☗"]
    const analysis = engine.analyzePosition(board, {maxDepth: 3}).analysis
    const topLeft = analysis.find(result => result.move[0] === 0 && result.move[1] === "✂")
    const bottomLeft = analysis.find(result => result.move[0] === 6 && result.move[1] === "✂")
    assert.equal(topLeft.score, bottomLeft.score)
})

test("cache entries cannot leak values between depth settings", () => {
    const board = ["☗", "", "", "", "🗋", "", "", "", "✂"]
    engine.clearCaches()
    const shallowBefore = engine.analyzePosition(board, {maxDepth: 2}).analysis
    engine.analyzePosition(board, {maxDepth: 6})
    const shallowAfter = engine.analyzePosition(board, {maxDepth: 2}).analysis
    assert.deepEqual(shallowAfter, shallowBefore)
})

test("skill maps monotonically to an explicit one-to-ten ply target", () => {
    const skills = [1, 100, 300, 500, 700, 850, 1000]
    const depths = skills.map(engine.skillToDepth)
    assert.equal(depths[0], 1)
    assert.equal(depths[2], 2)
    assert.equal(depths.at(-1), 10)
    depths.slice(1).forEach((depth, index) => assert.ok(depth >= depths[index]))
})

test("depth ten from an empty board stays within the optimized node budget", () => {
    engine.clearCaches()
    const result = engine.analyzePosition(EMPTY_BOARD, {maxDepth: 10})
    assert.equal(result.depth, 10)
    assert.ok(result.nodes < 250000, `searched ${result.nodes} nodes`)
})

test("worker messages echo request identity and report completed depth", () => {
    const workerSource = readFileSync(path.join(__dirname, "..", "rockfish.js"), "utf8")
    const messages = []
    const context = {
        console,
        performance,
        self: {postMessage: message => messages.push(message)}
    }
    vm.createContext(context)
    vm.runInContext(workerSource, context)
    context.self.onmessage({
        data: {type: "playMove", requestId: 42, board: EMPTY_BOARD, turn: "X", skill: 300}
    })

    assert.equal(messages.length, 1)
    assert.equal(messages[0].requestId, 42)
    assert.equal(messages[0].targetDepth, 2)
    assert.equal(messages[0].depth, 2)
    assert.equal(messages[0].analysis.length, 27)
})
