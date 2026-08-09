const assert = require("node:assert/strict")
const {readFileSync} = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const statsSource = readFileSync(path.join(__dirname, "..", "statsloader.js"), "utf8")

class FakeClassList {
    constructor() {
        this.values = new Set()
    }

    add(value) {
        this.values.add(value)
    }

    remove(value) {
        this.values.delete(value)
    }

    contains(value) {
        return this.values.has(value)
    }
}

class FakeElement {
    constructor() {
        this.classList = new FakeClassList()
        this.disabled = false
        this.hidden = false
        this.listeners = new Map()
        this.textContent = ""
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener)
    }

    dispatch(type) {
        return this.listeners.get(type)?.call(this, {currentTarget: this})
    }
}

function createStatsHarness(playerData = null, options = {}) {
    const ids = [
        "statsEmpty", "statsContent", "favPiece", "favPieceSymbol", "rockUses",
        "paperUses", "scissorUses", "favoriteSquare", "favoriteOpening",
        "replacementRate", "finishedGames", "datasetSummary", "datasetNote",
        "exportData", "resetLearning", "statsActionStatus"
    ]
    const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]))
    const warnings = []
    const downloads = []
    const document = {
        body: {appendChild() {}},
        createElement: () => ({
            click() { downloads.push(this.download) },
            remove() {}
        }),
        getElementById: id => elements[id] || null
    }
    const context = {
        Blob,
        console: {warn: (...args) => warnings.push(args)},
        confirm: () => options.confirm ?? true,
        Date,
        document,
        Promise,
        URL: {
            createObjectURL: () => "blob:test",
            revokeObjectURL() {}
        }
    }
    if (playerData) context.RpsxoPlayerData = playerData
    vm.createContext(context)
    vm.runInContext(statsSource, context)
    return {context, downloads, elements, warnings}
}

test("landing stats render tendencies and honest favorite ties", async () => {
    const summary = {
        moves: 8,
        pieces: {rock: 3, paper: 3, scissors: 2},
        favoritePieces: ["rock", "paper"],
        favoriteCells: [4],
        favoriteOpenings: [{cell: 0, piece: "paper"}],
        replacementRate: 0.375,
        gamesStarted: 3,
        gamesCompleted: 2,
        datasetGames: 3,
        datasetDecisions: 5,
        analyzedDecisions: 0,
        storageMode: "indexeddb"
    }
    const playerData = {
        async ready() {},
        async getSummary() { return summary },
        async exportData() { return {} },
        async resetLearning() { return summary }
    }
    const harness = createStatsHarness(playerData)
    await harness.context.loadStats()

    assert.equal(harness.elements.statsEmpty.hidden, true)
    assert.equal(harness.elements.statsContent.hidden, false)
    assert.equal(harness.elements.favPiece.textContent, "Rock + Paper")
    assert.equal(harness.elements.favPieceSymbol.textContent, "☗ 🗋")
    assert.equal(harness.elements.favoriteSquare.textContent, "center")
    assert.equal(harness.elements.favoriteOpening.textContent, "Paper in top left")
    assert.equal(harness.elements.replacementRate.textContent, "38%")
    assert.equal(harness.elements.finishedGames.textContent, "2")
    assert.equal(harness.elements.datasetSummary.textContent, "5 moves remembered across 3 games")
})

test("missing player-data support degrades without throwing", async () => {
    const harness = createStatsHarness()
    await harness.context.loadStats()

    assert.equal(harness.elements.statsContent.hidden, true)
    assert.match(harness.elements.statsEmpty.textContent, /could not be loaded/i)
    assert.equal(harness.elements.exportData.disabled, true)
    assert.equal(harness.elements.resetLearning.disabled, true)
    assert.equal(harness.warnings.length, 0)
})

test("reset clears learned games while preserving rendered aggregate stats", async () => {
    const before = {
        moves: 4,
        pieces: {rock: 4, paper: 0, scissors: 0},
        datasetGames: 1,
        datasetDecisions: 4,
        gamesCompleted: 1,
        storageMode: "indexeddb"
    }
    const after = {...before, datasetGames: 0, datasetDecisions: 0}
    let resetCalls = 0
    const playerData = {
        async ready() {},
        async getSummary() { return before },
        async exportData() { return {} },
        async resetLearning() {
            resetCalls += 1
            return after
        }
    }
    const harness = createStatsHarness(playerData)
    await harness.context.loadStats()
    await harness.elements.resetLearning.dispatch("click")

    assert.equal(resetCalls, 1)
    assert.equal(harness.elements.rockUses.textContent, "4")
    assert.equal(harness.elements.datasetSummary.textContent, "0 moves remembered across 0 games")
    assert.match(harness.elements.statsActionStatus.textContent, /overall stats are still here/i)
})
