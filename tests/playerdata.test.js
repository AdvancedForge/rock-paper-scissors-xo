const assert = require("node:assert/strict")
const test = require("node:test")

const playerData = require("../playerdata")

const ROCK = "\u2617"
const PAPER = "\uD83D\uDDCB"
const SCISSORS = "\u2702"
const EMPTY_BOARD = Array(9).fill("")

function makeClock(start = 1000) {
    let timestamp = start
    return () => {
        timestamp += 1
        return timestamp
    }
}

function makeIds(prefix = "game") {
    let sequence = 0
    return () => `${prefix}-${++sequence}`
}

function createTestStore(options = {}) {
    return playerData.createStore({
        storage: options.storage ?? playerData.createMemoryStorage(),
        legacyStorage: options.legacyStorage,
        now: options.now ?? makeClock(),
        makeId: options.makeId ?? makeIds(),
        sessionId: options.sessionId,
        warn: options.warn ?? (() => {})
    })
}

function moveEvent(overrides = {}) {
    return {
        mode: "singleplayer",
        starter: "X",
        humanTurn: "X",
        turn: "X",
        actor: "human",
        source: "click",
        boardBefore: [...EMPTY_BOARD],
        cell: 0,
        piece: ROCK,
        botSkill: 300,
        ...overrides
    }
}

function bitCount(mask) {
    let value = mask >>> 0
    let result = 0
    while (value) {
        value &= value - 1
        result += 1
    }
    return result
}

test("numeric board, action, and legal-mask encodings follow RPSXO rules", () => {
    const board = [ROCK, PAPER, SCISSORS, "", SCISSORS, "", PAPER, "", ROCK]
    const state = playerData.encodeBoard(board)
    assert.equal(Number.isInteger(state), true)
    assert.deepEqual(playerData.decodeBoard(state), board)

    for (let cell = 0; cell < 9; cell += 1) {
        for (const piece of [ROCK, PAPER, SCISSORS]) {
            const action = playerData.encodeAction(cell, piece)
            assert.equal(Number.isInteger(action), true)
            assert.deepEqual(playerData.decodeAction(action), [cell, piece])
        }
    }

    const emptyMask = playerData.legalActionMask(EMPTY_BOARD)
    assert.equal(bitCount(emptyMask), 27)
    const occupied = playerData.encodeBoard([ROCK, ...EMPTY_BOARD.slice(1)])
    const occupiedMask = playerData.legalActionMask(occupied)
    assert.equal(bitCount(occupiedMask), 25)
    assert.equal(playerData.isLegalAction(occupied, playerData.encodeAction(0, PAPER)), true)
    assert.equal(playerData.isLegalAction(occupied, playerData.encodeAction(0, ROCK)), false)
    assert.equal(playerData.isLegalAction(occupied, playerData.encodeAction(0, SCISSORS)), false)

    assert.throws(() => playerData.encodeBoard([ROCK]))
    assert.throws(() => playerData.encodeBoard(["bad", ...EMPTY_BOARD.slice(1)]))
    assert.throws(() => playerData.encodeAction(9, ROCK))
    assert.equal(playerData.isLegalAction(-1, 0), false)
})

test("complete timelines retain Rockfish moves but examples contain only human decisions", async () => {
    const store = createTestStore()
    const firstBoard = [...EMPTY_BOARD]
    const first = await store.recordMove(moveEvent({boardBefore: firstBoard}))
    firstBoard[0] = SCISSORS

    const afterHuman = [ROCK, ...EMPTY_BOARD.slice(1)]
    await store.recordMove(moveEvent({
        actor: "rockfish",
        source: "worker",
        turn: "O",
        boardBefore: afterHuman,
        cell: 1,
        piece: PAPER
    }))
    const afterRockfish = [ROCK, PAPER, ...EMPTY_BOARD.slice(2)]
    const second = await store.recordMove(moveEvent({
        boardBefore: afterRockfish,
        cell: 2,
        piece: SCISSORS
    }))

    const exported = await store.exportData()
    assert.equal(exported.games.length, 1)
    assert.deepEqual(exported.games[0].moves.map(move => move.actor), [
        "human", "rockfish", "human"
    ])
    assert.equal(exported.games[0].examples.length, 2)
    assert.deepEqual(exported.decisions.map(example => example.id), [
        first.sampleId, second.sampleId
    ])
    assert.equal(exported.decisions.every(example => (
        Number.isInteger(example.inputs.boardBefore) &&
        Number.isInteger(example.inputs.legalMask) &&
        Number.isInteger(example.target.chosenAction)
    )), true)
    assert.deepEqual(exported.decisions[0].inputs.historyTail, [])
    assert.deepEqual(exported.decisions[1].inputs.historyTail, [
        playerData.encodeAction(0, ROCK),
        playerData.encodeAction(1, PAPER)
    ])

    const summary = await store.getSummary()
    assert.equal(summary.moves, 2)
    assert.deepEqual(summary.pieces, {rock: 1, paper: 0, scissors: 1})
    assert.equal(summary.datasetGames, 1)
    assert.equal(summary.datasetDecisions, 2)
})

test("illegal or terminal-board events do not start games or change aggregates", async () => {
    const store = createTestStore()
    const occupiedBoard = [ROCK, ...EMPTY_BOARD.slice(1)]
    assert.equal(await store.recordMove(moveEvent({
        boardBefore: occupiedBoard,
        cell: 0,
        piece: ROCK
    })), null)
    assert.equal(await store.recordMove(moveEvent({
        boardBefore: occupiedBoard,
        cell: 0,
        piece: SCISSORS
    })), null)
    assert.equal(await store.recordMove(moveEvent({cell: 99})), null)
    assert.equal(await store.recordMove(moveEvent({piece: "unknown"})), null)
    assert.equal(await store.recordMove(moveEvent({mode: "twoplayer"})), null)

    const wonBoard = [ROCK, ROCK, ROCK, "", "", "", "", "", ""]
    assert.equal(await store.recordMove(moveEvent({boardBefore: wonBoard, cell: 3})), null)

    const summary = await store.getSummary()
    assert.equal(summary.moves, 0)
    assert.equal(summary.gamesStarted, 0)
    assert.equal(summary.datasetGames, 0)
    assert.equal(summary.datasetDecisions, 0)
})

test("record inputs, returned exports, and analysis payloads cannot mutate stored data", async () => {
    const store = createTestStore()
    const board = [...EMPTY_BOARD]
    const recordPromise = store.recordMove(moveEvent({boardBefore: board}))
    board[0] = PAPER
    const identity = await recordPromise

    const analysis = {
        depth: 2,
        targetDepth: 4,
        analysis: [
            {move: [0, ROCK], score: 10},
            {move: [1, PAPER], score: 20}
        ]
    }
    assert.equal(await store.attachAnalysis(identity, analysis), true)
    analysis.analysis[0].score = 99999
    analysis.analysis.push({move: [2, SCISSORS], score: 99999})

    const firstExport = await store.exportData()
    assert.equal(firstExport.games[0].moves[0].boardBefore, 0)
    assert.equal(firstExport.decisions[0].rockfish.chosenScore, 10)
    firstExport.games[0].moves[0].boardBefore = 123
    firstExport.decisions[0].rockfish.scores.fill(99999)
    firstExport.profile.lifetime.pieces.rock = 99999

    const secondExport = await store.exportData()
    assert.equal(secondExport.games[0].moves[0].boardBefore, 0)
    assert.equal(secondExport.decisions[0].rockfish.chosenScore, 10)
    assert.equal(secondExport.profile.lifetime.pieces.rock, 1)
})

test("analysis is associated by game, sample, and exact pre-move board", async () => {
    const store = createTestStore()
    const first = await store.recordMove(moveEvent({cell: 0, piece: ROCK}))
    await store.recordMove(moveEvent({
        actor: "rockfish",
        turn: "O",
        boardBefore: [ROCK, ...EMPTY_BOARD.slice(1)],
        cell: 1,
        piece: PAPER
    }))
    const secondBoard = [ROCK, PAPER, ...EMPTY_BOARD.slice(2)]
    const second = await store.recordMove(moveEvent({
        boardBefore: secondBoard,
        cell: 2,
        piece: SCISSORS
    }))

    assert.equal(await store.attachAnalysis(
        {...first, boardKey: second.boardKey},
        {analysis: [{move: [0, ROCK], score: 1}]}
    ), false)
    assert.equal(await store.attachAnalysis(
        {...second, sampleId: first.sampleId},
        {analysis: [{move: [2, SCISSORS], score: 2}]}
    ), false)
    assert.equal(await store.attachAnalysis(second, {
        engineVersion: "test-engine",
        depth: 4,
        targetDepth: 6,
        analysis: [
            {move: [2, SCISSORS], score: 5},
            {move: [3, ROCK], score: 20},
            {move: [99, ROCK], score: 1000},
            {move: [4, PAPER], score: Infinity}
        ]
    }), true)
    assert.equal(await store.attachAnalysis(first, {
        scores: Array.from({length: 27}, (_, action) => action)
    }), true)

    const exported = await store.exportData()
    const firstExample = exported.decisions.find(example => example.id === first.sampleId)
    const secondExample = exported.decisions.find(example => example.id === second.sampleId)
    assert.equal(firstExample.rockfish.status, "complete")
    assert.equal(firstExample.rockfish.chosenScore, playerData.encodeAction(0, ROCK))
    assert.equal(secondExample.rockfish.engineVersion, "test-engine")
    assert.equal(secondExample.rockfish.chosenScore, 5)
    assert.equal(secondExample.rockfish.bestScore, 20)
    assert.equal(secondExample.rockfish.regret, 15)
    assert.equal((await store.getSummary()).analyzedDecisions, 2)
})

test("a winning human move is retained before completion finalizes every outcome", async () => {
    const store = createTestStore()
    const sequence = [
        moveEvent({boardBefore: [...EMPTY_BOARD], cell: 0, piece: ROCK}),
        moveEvent({
            actor: "rockfish", turn: "O", boardBefore: [ROCK, "", "", "", "", "", "", "", ""],
            cell: 3, piece: PAPER
        }),
        moveEvent({boardBefore: [ROCK, "", "", PAPER, "", "", "", "", ""], cell: 1, piece: ROCK}),
        moveEvent({
            actor: "rockfish", turn: "O", boardBefore: [ROCK, ROCK, "", PAPER, "", "", "", "", ""],
            cell: 4, piece: SCISSORS
        }),
        moveEvent({
            boardBefore: [ROCK, ROCK, "", PAPER, SCISSORS, "", "", "", ""],
            cell: 2, piece: ROCK
        })
    ]
    for (const event of sequence) assert.ok(await store.recordMove(event))

    const finished = await store.finishGame({
        winner: "X",
        winningPiece: ROCK,
        winningLine: [0, 1, 2]
    })
    assert.equal(finished.status, "completed")
    assert.equal(finished.examples.length, 3)
    assert.deepEqual(finished.examples.map(example => example.outcome), [
        {status: "completed", valueForHuman: 1, pliesToEnd: 4},
        {status: "completed", valueForHuman: 1, pliesToEnd: 2},
        {status: "completed", valueForHuman: 1, pliesToEnd: 0}
    ])
    assert.equal(finished.examples.every(example => example.training.outcomeEligible), true)
    assert.equal(await store.finishGame({winner: "X"}), null)

    const summary = await store.getSummary()
    assert.equal(summary.gamesCompleted, 1)
    assert.equal(summary.wins, 1)
    assert.equal(summary.losses, 0)
    assert.equal(summary.datasetDecisions, 3)
})

test("restart abandonment is idempotent and marks examples outcome-ineligible", async () => {
    const store = createTestStore({makeId: makeIds("abandon")})
    await store.recordMove(moveEvent())
    const abandoned = await store.abandonGame("restart")
    assert.equal(abandoned.status, "abandoned")
    assert.equal(abandoned.termination, "restart")
    assert.equal(abandoned.examples[0].outcome.status, "abandoned")
    assert.equal(abandoned.examples[0].training.outcomeEligible, false)
    assert.equal(await store.abandonGame("restart"), null)

    const second = await store.recordMove(moveEvent({starter: "O"}))
    assert.equal(second.gameId, "abandon-2")
    const summary = await store.getSummary()
    assert.equal(summary.gamesStarted, 2)
    assert.equal(summary.abandoned, 1)
})

test("loading a stale persisted active game recovers it as abandoned", async () => {
    const storage = playerData.createMemoryStorage()
    const firstStore = createTestStore({
        storage, makeId: () => "recover-me", sessionId: "same-browser-tab",
        now: makeClock(1000)
    })
    await firstStore.recordMove(moveEvent())

    const recoveredStore = createTestStore({
        storage, makeId: makeIds("later"), sessionId: "same-browser-tab",
        now: makeClock(50000000)
    })
    await recoveredStore.ready()
    const exported = await recoveredStore.exportData()
    assert.equal(exported.games.length, 1)
    assert.equal(exported.games[0].status, "abandoned")
    assert.equal(exported.games[0].termination, "recovered")
    assert.equal(exported.games[0].examples[0].outcome.status, "abandoned")
    assert.equal((await recoveredStore.getSummary()).abandoned, 1)
})

test("same-tab initialization cannot split a terminal move from finalization", async () => {
    const storage = playerData.createMemoryStorage()
    const playingPage = createTestStore({
        storage, makeId: () => "winning-game", sessionId: "same-tab"
    })
    await playingPage.recordMove(moveEvent({
        boardBefore: [ROCK, ROCK, "", "", "", "", "", "", ""],
        cell: 2,
        piece: ROCK
    }))

    const destinationPage = createTestStore({storage, sessionId: "same-tab"})
    await destinationPage.ready()
    assert.equal((await destinationPage.getSummary()).abandoned, 0)

    const finished = await playingPage.finishGame({
        winner: "X", winningPiece: ROCK, winningLine: [0, 1, 2]
    })
    assert.equal(finished.status, "completed")
    assert.equal((await destinationPage.getSummary()).gamesCompleted, 1)
    assert.equal((await destinationPage.getSummary()).abandoned, 0)
})

test("a second live session cannot abandon or overwrite the active game", async () => {
    const storage = playerData.createMemoryStorage()
    const firstStore = createTestStore({
        storage, makeId: () => "owned-game", sessionId: "first-tab"
    })
    await firstStore.recordMove(moveEvent())

    const secondStore = createTestStore({
        storage, makeId: () => "other-game", sessionId: "second-tab"
    })
    await secondStore.ready()
    assert.equal((await secondStore.getSummary()).abandoned, 0)
    assert.equal(await secondStore.abandonGame("restart"), null)
    assert.equal(await secondStore.recordMove(moveEvent()), null)

    assert.ok(await firstStore.recordMove(moveEvent({
        actor: "rockfish",
        turn: "O",
        boardBefore: [ROCK, ...EMPTY_BOARD.slice(1)],
        cell: 1,
        piece: PAPER
    })))
    const exported = await firstStore.exportData()
    assert.equal(exported.games[0].status, "in_progress")
    assert.equal(exported.games[0].moves.length, 2)
})

test("startup replays an interrupted journal before reading the dataset", async () => {
    const storage = playerData.createMemoryStorage()
    const original = createTestStore({
        storage, makeId: () => "journal-game", sessionId: "journal-owner"
    })
    await original.recordMove(moveEvent())
    const profile = await storage.getItem("profile")
    const manifest = await storage.getItem("manifest")
    const game = await storage.getItem("game:journal-game")
    await storage.setItem("pending-transaction", {
        schemaVersion: 1,
        profile,
        meta: manifest,
        game,
        removedKeys: []
    })
    await storage.removeItem("profile")
    await storage.removeItem("manifest")

    const recovered = createTestStore({storage, sessionId: "other-tab"})
    await recovered.ready()
    assert.equal((await recovered.exportData()).games[0].moves.length, 1)
    assert.ok(await storage.getItem("profile"))
    assert.ok(await storage.getItem("manifest"))
    assert.equal(await storage.getItem("pending-transaction"), null)
})

test("legacy favorite-piece stats migrate without inventing training examples", async () => {
    const legacyUser = {
        rating: 135,
        bestRating: 170,
        ratingHistory: [100, 135],
        WLR: [4, 2],
        WLA: [8, 6],
        R: 7,
        P: 3,
        S: 2,
        R0: 4,
        R1: 3,
        P4: 3,
        S8: 2
    }
    const legacyStorage = playerData.createMemoryStorage({user: legacyUser})
    const storage = playerData.createMemoryStorage()
    const store = createTestStore({storage, legacyStorage})
    await store.ready()

    const summary = await store.getSummary()
    assert.equal(summary.moves, 12)
    assert.deepEqual(summary.pieces, {rock: 7, paper: 3, scissors: 2})
    assert.deepEqual(summary.favoritePieces, ["rock"])
    assert.equal(summary.replacementRate, null)
    assert.equal(summary.datasetGames, 0)
    assert.equal(summary.datasetDecisions, 0)

    const exported = await store.exportData()
    assert.equal(exported.profile.legacy.rating, 135)
    assert.equal(exported.profile.legacy.bestRating, 170)
    assert.deepEqual(exported.profile.legacy.ratingHistory, [100, 135])
    assert.deepEqual(exported.profile.legacy.WLR, [4, 2])

    const reloaded = createTestStore({storage, legacyStorage})
    assert.equal((await reloaded.getSummary()).moves, 12)
})

test("a failed legacy read remains retryable instead of erasing old stats", async () => {
    const storage = playerData.createMemoryStorage()
    let shouldFail = true
    const legacyStorage = {
        async getItem(key) {
            if (shouldFail) throw new Error("legacy temporarily unavailable")
            return key === "user" ? {R: 4, P: 2, S: 1} : null
        }
    }
    const first = createTestStore({storage, legacyStorage})
    assert.equal((await first.getSummary()).moves, 0)

    shouldFail = false
    const retried = createTestStore({storage, legacyStorage})
    assert.equal((await retried.getSummary()).moves, 7)
    assert.deepEqual((await retried.getSummary()).pieces, {
        rock: 4, paper: 2, scissors: 1
    })
})

test("export is detached and reset removes learning records while preserving aggregates", async () => {
    const store = createTestStore()
    await store.recordMove(moveEvent())
    await store.abandonGame("restart")

    const before = await store.exportData()
    assert.equal(before.schemaVersion, playerData.DATA_SCHEMA_VERSION)
    assert.equal(before.featureVersion, playerData.FEATURE_SCHEMA_VERSION)
    assert.equal(before.games.length, 1)
    assert.equal(before.decisions.length, 1)

    const resetSummary = await store.resetLearning()
    assert.equal(resetSummary.moves, 1)
    assert.deepEqual(resetSummary.pieces, {rock: 1, paper: 0, scissors: 0})
    assert.equal(resetSummary.datasetGames, 0)
    assert.equal(resetSummary.datasetDecisions, 0)
    assert.equal(resetSummary.gamesStarted, 1)
    assert.equal(resetSummary.abandoned, 1)

    const after = await store.exportData()
    assert.deepEqual(after.games, [])
    assert.deepEqual(after.decisions, [])
    assert.equal(after.profile.lifetime.moves, 1)
})

test("reset also erases orphaned game records left by an interrupted write", async () => {
    const storage = playerData.createMemoryStorage()
    const store = createTestStore({storage})
    await store.ready()
    await storage.setItem("game:orphaned-write", {
        id: "orphaned-write",
        moves: [{actionId: 0}],
        examples: [{id: "private-example"}]
    })

    await store.resetLearning()
    assert.equal(await storage.getItem("game:orphaned-write"), null)
    assert.deepEqual((await storage.keys()).sort(), ["manifest", "profile"])
})

test("missing and failed persistent storage fall back to usable session memory", async () => {
    const memoryOnly = playerData.createStore({
        storage: null,
        now: makeClock(),
        makeId: makeIds("memory"),
        warn: () => {}
    })
    await memoryOnly.recordMove(moveEvent())
    assert.equal((await memoryOnly.getSummary()).storageMode, "memory")
    assert.equal((await memoryOnly.getSummary()).datasetDecisions, 1)

    let warnings = 0
    const brokenStorage = {
        async getItem() { throw new Error("read failed") },
        async setItem() { throw new Error("write failed") },
        async removeItem() { throw new Error("remove failed") }
    }
    const fallback = createTestStore({
        storage: brokenStorage,
        warn: () => { warnings += 1 }
    })
    await fallback.ready()
    await fallback.recordMove(moveEvent())
    assert.equal((await fallback.getSummary()).storageMode, "memory")
    assert.equal((await fallback.getSummary()).datasetDecisions, 1)
    assert.equal(warnings, 1)
})

test("mutations serialize persistent writes and cannot lose rapid moves", async () => {
    const backing = playerData.createMemoryStorage()
    let activeWrites = 0
    let maximumConcurrentWrites = 0
    const delayedStorage = {
        getItem: key => backing.getItem(key),
        removeItem: key => backing.removeItem(key),
        async setItem(key, value) {
            activeWrites += 1
            maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites)
            await new Promise(resolve => setTimeout(resolve, 1))
            await backing.setItem(key, value)
            activeWrites -= 1
            return value
        }
    }
    const store = createTestStore({storage: delayedStorage})
    const first = store.recordMove(moveEvent({cell: 0, piece: ROCK}))
    const second = store.recordMove(moveEvent({
        actor: "rockfish",
        turn: "O",
        boardBefore: [ROCK, ...EMPTY_BOARD.slice(1)],
        cell: 1,
        piece: PAPER
    }))
    const third = store.recordMove(moveEvent({
        boardBefore: [ROCK, PAPER, ...EMPTY_BOARD.slice(2)],
        cell: 2,
        piece: SCISSORS
    }))
    await Promise.all([first, second, third])

    assert.equal(maximumConcurrentWrites, 1)
    const exported = await store.exportData()
    assert.equal(exported.games[0].moves.length, 3)
    assert.equal(exported.decisions.length, 2)
})

test("detailed retention is bounded while lifetime aggregates remain cumulative", async () => {
    const store = createTestStore({makeId: makeIds("retained")})
    for (let index = 0; index < 501; index += 1) {
        await store.recordMove(moveEvent())
        await store.abandonGame("restart")
    }

    const summary = await store.getSummary()
    assert.equal(summary.datasetGames, 500)
    assert.equal(summary.datasetDecisions, 500)
    assert.equal(summary.gamesStarted, 501)
    assert.equal(summary.abandoned, 501)
    assert.equal(summary.moves, 501)
    assert.equal((await store.exportData()).games[0].id, "retained-2")
})
