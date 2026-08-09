const assert = require("node:assert/strict")
const {readFileSync} = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const engine = require("../rockfish")
const playerDataSource = readFileSync(path.join(__dirname, "..", "playerdata.js"), "utf8")
const uiSource = readFileSync(path.join(__dirname, "..", "rpsxo.js"), "utf8")
const UNIQUE_MOVE_SHAPES = Array.from({length: 9}, (_, cell) => (
    ["☗", "🗋", "✂"].map(piece => [cell, piece])
)).flat()

test("every HTML entry point declares UTF-8 before page content", () => {
    for (const filename of ["index.html", "playground.html", "tutorial.html"]) {
        const html = readFileSync(path.join(__dirname, "..", filename), "utf8")
        assert.match(html, /<head>\s*<meta charset="UTF-8">/i, filename)
    }

    const playground = readFileSync(path.join(__dirname, "..", "playground.html"), "utf8")
    assert.match(playground, /<script src="playerdata\.js"><\/script>\s*<script src="rockfish\.js"><\/script>\s*<script src="rpsxo\.js"><\/script>/)
})

class FakeClassList {
    constructor(...classes) {
        this.classes = new Set(classes)
    }

    add(className) {
        this.classes.add(className)
    }

    remove(className) {
        this.classes.delete(className)
    }

    contains(className) {
        return this.classes.has(className)
    }
}

class FakeElement {
    constructor({textContent = "", value = ""} = {}) {
        this.textContent = textContent
        this.value = value
        this.classList = new FakeClassList()
        this.listeners = new Map()
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener)
    }

    dispatch(type) {
        const listener = this.listeners.get(type)
        if (listener) listener.call(this, {currentTarget: this})
    }
}

function createHarness(randomValue = 0, options = {}) {
    const cells = Array.from({length: 9}, () => new FakeElement())
    const elements = {
        restartX: new FakeElement(),
        restartO: new FakeElement(),
        turnTracker: new FakeElement({textContent: "X's turn"}),
        selectRock: new FakeElement(),
        selectPaper: new FakeElement(),
        selectScissors: new FakeElement(),
        singleplayer: new FakeElement(),
        twoplayer: new FakeElement(),
        botSkill: new FakeElement({value: "300"}),
        botSkillP: new FakeElement({textContent: "300"})
    }
    elements.selectRock.classList.add("selectedBtn")
    elements.singleplayer.classList.add("selectedBtn")

    let nextTimerId = 1
    const timers = new Map()
    const setTimeout = (callback, delay = 0) => {
        const id = nextTimerId
        nextTimerId += 1
        timers.set(id, {callback, delay})
        return id
    }
    const clearTimeout = id => timers.delete(id)
    const runTimers = delay => {
        let ranTimer = true
        while (ranTimer) {
            ranTimer = false
            for (const [id, timer] of [...timers]) {
                if (timer.delay !== delay) continue
                timers.delete(id)
                timer.callback()
                ranTimer = true
            }
        }
    }

    const workers = []
    class FakeWorker {
        constructor(url) {
            this.url = url
            this.messages = []
            this.terminated = false
            this.throwOnPost = false
            workers.push(this)
        }

        postMessage(message) {
            if (this.throwOnPost) throw new Error("post failed")
            this.messages.push(message)
        }

        terminate() {
            this.terminated = true
        }

        deliver(data) {
            this.onmessage({data})
        }

        fail() {
            let prevented = false
            this.onerror({preventDefault: () => { prevented = true }})
            return prevented
        }
    }

    const savedUsers = []
    const storedValues = new Map()
    const consoleErrors = []
    const context = {
        Array,
        clearTimeout,
        console: {error: (...args) => consoleErrors.push(args), warn() {}},
        document: {
            querySelectorAll: selector => selector === ".cell" ? cells : [],
            getElementById: id => elements[id] ?? null
        },
        localforage: {
            getItem: async key => storedValues.has(key) ? storedValues.get(key) : null,
            setItem: async (key, value) => {
                storedValues.set(key, value)
                savedUsers.push({...value})
            },
            removeItem: async key => { storedValues.delete(key) },
            keys: async () => [...storedValues.keys()]
        },
        Math: Object.create(Math),
        location: {protocol: options.protocol ?? "https:"},
        Promise,
        setTimeout,
        Worker: FakeWorker
    }
    if (options.Rockfish) context.Rockfish = options.Rockfish
    if (options.playerData) context.RpsxoPlayerData = options.playerData
    if (options.loadPlayerData) context.window = context
    context.Math.random = () => randomValue
    vm.createContext(context)
    if (options.loadPlayerData) vm.runInContext(playerDataSource, context)
    vm.runInContext(uiSource, context)

    return {
        cells, consoleErrors, context, elements, runTimers, savedUsers,
        storedValues, timers, workers
    }
}

function createPlayerDataSpy() {
    const calls = []
    const api = {}
    for (const method of ["ready", "recordMove", "finishGame", "abandonGame"]) {
        api[method] = payload => { calls.push({method, payload}) }
    }
    return {api, calls}
}

test("accepted single-player moves feed a human example and an AI context move", () => {
    const playerData = createPlayerDataSpy()
    const harness = createHarness(0, {playerData: playerData.api})
    assert.equal(playerData.calls[0].method, "ready")

    harness.cells[0].dispatch("click")
    const humanCall = playerData.calls.find(call => call.method === "recordMove")
    assert.deepEqual(Array.from(humanCall.payload.boardBefore), Array(9).fill(""))
    assert.equal(humanCall.payload.actor, "human")
    assert.equal(humanCall.payload.turn, "X")
    assert.equal(humanCall.payload.cell, 0)
    assert.equal(humanCall.payload.piece, "☗")

    harness.runTimers(0)
    const worker = harness.workers[0]
    worker.deliver({
        requestId: worker.messages[0].requestId,
        analysis: [{move: [4, "🗋"], score: 10}]
    })

    const moveCalls = playerData.calls.filter(call => call.method === "recordMove")
    assert.equal(moveCalls.length, 2)
    assert.equal(moveCalls[1].payload.actor, "rockfish")
    assert.equal(moveCalls[1].payload.source, "worker")
    assert.equal(moveCalls[1].payload.boardBefore[0], "☗")
})

test("the real browser data module receives the UI timeline end to end", async () => {
    const harness = createHarness(0, {loadPlayerData: true})
    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const worker = harness.workers[0]
    worker.deliver({
        requestId: worker.messages[0].requestId,
        analysis: [{move: [4, "🗋"], score: 10}]
    })

    const exported = await harness.context.RpsxoPlayerData.exportData()
    assert.equal(exported.games.length, 1)
    assert.deepEqual(Array.from(exported.games[0].moves, move => move.actor), [
        "human", "rockfish"
    ])
    assert.equal(exported.decisions.length, 1)
    assert.equal(exported.decisions[0].inputs.boardBefore, 0)
    assert.equal(exported.decisions[0].target.chosenAction, 0)
})

test("an O-first game records Rockfish's opening as timeline context", () => {
    const playerData = createPlayerDataSpy()
    const harness = createHarness(0, {playerData: playerData.api})

    harness.elements.restartO.dispatch("click")
    harness.runTimers(0)
    const worker = harness.workers.at(-1)
    worker.deliver({
        requestId: worker.messages[0].requestId,
        analysis: [{move: [4, "🗋"], score: 10}]
    })

    const moveCall = playerData.calls.find(call => call.method === "recordMove")
    assert.equal(moveCall.payload.actor, "rockfish")
    assert.equal(moveCall.payload.starter, "O")
    assert.equal(moveCall.payload.turn, "O")
    assert.deepEqual(Array.from(moveCall.payload.boardBefore), Array(9).fill(""))
})

test("an AI move keeps the skill captured when its request started", () => {
    const playerData = createPlayerDataSpy()
    const harness = createHarness(0, {playerData: playerData.api})

    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const worker = harness.workers[0]
    const request = worker.messages[0]
    harness.elements.botSkill.value = "900"
    harness.elements.botSkill.dispatch("input")
    worker.deliver({
        requestId: request.requestId,
        analysis: [{move: [4, "🗋"], score: 10}]
    })

    const aiMove = playerData.calls.filter(call => call.method === "recordMove").at(-1)
    assert.equal(aiMove.payload.actor, "rockfish")
    assert.equal(aiMove.payload.botSkill, 300)
})

test("illegal and local-player clicks do not feed personal player data", () => {
    const playerData = createPlayerDataSpy()
    const harness = createHarness(0, {playerData: playerData.api})

    harness.elements.twoplayer.dispatch("click")
    harness.cells[0].dispatch("click")
    harness.cells[0].dispatch("click")

    assert.equal(playerData.calls.some(call => call.method === "recordMove"), false)
})

test("a winning move is recorded before its result is finalized", () => {
    const playerData = createPlayerDataSpy()
    const harness = createHarness(0, {playerData: playerData.api})

    // Use direct accepted moves so the fixture remains single-player while
    // exercising the shared commit path for both sides.
    harness.context.playMove(harness.cells[0], "☗", {actor: "human", source: "click"})
    harness.context.playMove(harness.cells[3], "☗", {actor: "rockfish", source: "worker"})
    harness.context.playMove(harness.cells[1], "☗", {actor: "human", source: "click"})
    harness.context.playMove(harness.cells[4], "☗", {actor: "rockfish", source: "worker"})
    harness.context.playMove(harness.cells[2], "☗", {actor: "human", source: "click"})

    const relevantCalls = playerData.calls.filter(call => (
        call.method === "recordMove" || call.method === "finishGame"
    ))
    assert.equal(relevantCalls.at(-2).method, "recordMove")
    assert.equal(relevantCalls.at(-2).payload.cell, 2)
    assert.equal(relevantCalls.at(-1).method, "finishGame")
    assert.equal(relevantCalls.at(-1).payload.winner, "X")
    assert.deepEqual(Array.from(relevantCalls.at(-1).payload.winningLine), [0, 1, 2])
})

test("the displayed default skill is the skill sent to Rockfish", () => {
    const harness = createHarness()
    harness.cells[0].dispatch("click")
    assert.equal(harness.elements.turnTracker.textContent, "O is thinking…")
    assert.equal(harness.workers[0].messages.length, 0)

    harness.runTimers(0)
    assert.equal(harness.workers[0].messages.length, 1)
    assert.equal(harness.workers[0].messages[0].skill, 300)
})

test("file URLs use the in-page engine without constructing a Worker", () => {
    let inlineRequest = null
    const Rockfish = {
        skillToTimeLimit: skill => skill,
        analyzePosition: (board, options) => {
            inlineRequest = {board: [...board], options: {...options}}
            return {analysis: [{move: [4, "🗋"], score: 10}], depth: 2}
        }
    }
    const harness = createHarness(0, {protocol: "file:", Rockfish})

    assert.equal(harness.workers.length, 0)
    harness.cells[0].dispatch("click")
    harness.runTimers(0)

    assert.deepEqual(inlineRequest.board, ["☗", "", "", "", "", "", "", "", ""])
    assert.equal(inlineRequest.options.skill, 300)
    assert.equal(inlineRequest.options.timeLimitMs, 300)
    assert.equal(inlineRequest.options.iterative, true)
    assert.equal(harness.cells[4].textContent, "🗋")
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
    assert.equal(harness.consoleErrors.length, 0)

    harness.elements.restartO.dispatch("click")
    harness.runTimers(0)
    assert.equal(harness.workers.length, 0)
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
})

test("an in-page engine failure falls back without locking file play", () => {
    const Rockfish = {
        skillToTimeLimit: () => 25,
        analyzePosition: () => { throw new Error("inline failure") }
    }
    const harness = createHarness(0, {protocol: "file:", Rockfish})

    harness.cells[0].dispatch("click")
    harness.runTimers(0)

    assert.equal(harness.workers.length, 0)
    assert.equal(harness.cells[0].textContent, "🗋")
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
    assert.equal(harness.consoleErrors.length, 1)
})

test("an AI reply preserves the human piece selection", () => {
    const harness = createHarness()
    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const worker = harness.workers[0]
    const request = worker.messages[0]

    worker.deliver({
        requestId: request.requestId,
        analysis: [{move: [4, "🗋"], score: 10}]
    })

    assert.equal(harness.cells[4].textContent, "🗋")
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
    assert.equal(harness.elements.selectRock.classList.contains("selectedBtn"), true)
    assert.equal(harness.elements.selectPaper.classList.contains("selectedBtn"), false)
})

test("each original symbol can complete a winning line in local play", () => {
    const pieces = [
        ["selectRock", "☗"],
        ["selectPaper", "🗋"],
        ["selectScissors", "✂"]
    ]

    for (const [selector, piece] of pieces) {
        const harness = createHarness()
        harness.elements.twoplayer.dispatch("click")
        harness.elements[selector].dispatch("click")
        for (const cell of [0, 3, 1, 4, 2]) harness.cells[cell].dispatch("click")

        assert.deepEqual(harness.cells.slice(0, 3).map(cell => cell.textContent), [piece, piece, piece])
        assert.equal(harness.elements.turnTracker.textContent, "X wins!")

        harness.cells[5].dispatch("click")
        assert.equal(harness.cells[5].textContent, "")
    }
})

test("skill one keeps the deliberately random beginner behavior", () => {
    const harness = createHarness(0.99)
    harness.elements.botSkill.value = "1"
    harness.elements.botSkill.dispatch("input")
    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const worker = harness.workers[0]
    const request = worker.messages[0]

    worker.deliver({
        requestId: request.requestId,
        analysis: [
            {move: [1, "☗"], score: 10000},
            {move: [2, "🗋"], score: 0},
            {move: [3, "✂"], score: -10000}
        ]
    })

    assert.equal(harness.cells[3].textContent, "✂")
})

test("move-choice weighting strengthens smoothly without premature determinism", () => {
    const harness = createHarness()
    const analysis = [
        {move: [0, "☗"], score: 30},
        {move: [1, "🗋"], score: 20},
        {move: [2, "✂"], score: 10}
    ]
    const skills = [1, 100, 300, 500, 700, 900, 1000]
    const probabilitySets = skills.map(skill => (
        Array.from(harness.context.moveSelectionProbabilities(analysis, skill))
    ))

    probabilitySets.forEach(probabilities => {
        assert.ok(probabilities.every(probability => Number.isFinite(probability) && probability >= 0))
        assert.ok(Math.abs(probabilities.reduce((sum, probability) => sum + probability, 0) - 1) < 1e-12)
    })
    probabilitySets.slice(1).forEach((probabilities, index) => {
        assert.ok(probabilities[0] >= probabilitySets[index][0])
    })

    assert.deepEqual(probabilitySets[0].map(value => Math.round(value * 3)), [1, 1, 1])
    assert.ok(probabilitySets[4][0] < 0.6)
    assert.ok(probabilitySets[5][0] < 0.8)
    assert.deepEqual(probabilitySets.at(-1), [1, 0, 0])
})

test("large heuristic gaps matter more than near ties", () => {
    const harness = createHarness()
    const closeScores = [
        {move: [0, "☗"], score: 1},
        {move: [1, "🗋"], score: 0}
    ]
    const distantScores = [
        {move: [0, "☗"], score: 800},
        {move: [1, "🗋"], score: -800}
    ]
    const closeProbabilities = Array.from(harness.context.moveSelectionProbabilities(closeScores, 700))
    const distantProbabilities = Array.from(harness.context.moveSelectionProbabilities(distantScores, 700))

    assert.ok(closeProbabilities[1] > 0.3)
    assert.ok(distantProbabilities[1] < 0.15)
    assert.ok(distantProbabilities[1] < closeProbabilities[1] / 2)
})

test("depth cross-fades join moves by identity and mix probability vectors", () => {
    const harness = createHarness()
    const currentAnalysis = [
        {move: [0, "☗"], score: 20},
        {move: [1, "🗋"], score: 10}
    ]
    const previousAnalysis = [
        {move: [1, "🗋"], score: 20},
        {move: [0, "☗"], score: 10}
    ]

    const previousOnly = Array.from(harness.context.moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, 0
    ))
    const halfway = Array.from(harness.context.moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, 0.5
    ))
    const currentOnly = Array.from(harness.context.moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, 1
    ))
    const malformedBlend = Array.from(harness.context.moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, null
    ))

    assert.ok(previousOnly[1] > previousOnly[0])
    assert.ok(currentOnly[0] > currentOnly[1])
    assert.deepEqual(malformedBlend, currentOnly)
    assert.ok(Math.abs(halfway[0] - 0.5) < 1e-12)
    assert.ok(Math.abs(halfway[1] - 0.5) < 1e-12)
})

test("a one-point skill change cross-fades instead of jumping depth policies", () => {
    const harness = createHarness()
    const board = ["☗", "🗋", "☗", "✂", "", "✂", "🗋", "✂", "🗋"]
    const referenceScores = new Map(engine.analyzePosition(board, {maxDepth: 10}).analysis.map(entry => (
        [JSON.stringify(entry.move), entry.score]
    )))
    const expectedReferenceScore = (result, skill) => {
        const probabilities = Array.from(harness.context.moveSelectionProbabilities(
            result.analysis,
            skill,
            result.previousAnalysis,
            result.depthBlend
        ))
        return probabilities.reduce((sum, probability, index) => (
            sum + (probability * referenceScores.get(JSON.stringify(result.analysis[index].move)))
        ), 0)
    }

    const beforeBoundary = engine.analyzePosition(board, {skill: 354})
    const afterBoundary = engine.analyzePosition(board, {skill: 355})
    const beforeScore = expectedReferenceScore(beforeBoundary, 354)
    const afterScore = expectedReferenceScore(afterBoundary, 355)

    assert.equal(beforeBoundary.depth, 2)
    assert.equal(afterBoundary.depth, 4)
    assert.ok(afterBoundary.depthBlend < 0.01)
    assert.ok(Math.abs(afterScore - beforeScore) < 100, `${beforeScore} -> ${afterScore}`)
})

test("equal scores stay equal and proven outcomes become more reliable with skill", () => {
    const harness = createHarness()
    const analysis = [
        {move: UNIQUE_MOVE_SHAPES[0], score: 10000},
        {move: UNIQUE_MOVE_SHAPES[1], score: 10000},
        {move: UNIQUE_MOVE_SHAPES[2], score: 20},
        ...UNIQUE_MOVE_SHAPES.slice(3, 19).map(move => ({move, score: -10000}))
    ]

    let previousWinProbability = 0
    let previousLossProbability = 1
    let previousExpectedScore = -Infinity
    for (let skill = 1; skill <= 1000; skill += 1) {
        const probabilities = Array.from(harness.context.moveSelectionProbabilities(analysis, skill))
        const winProbability = probabilities[0] + probabilities[1]
        const lossProbability = probabilities.slice(3).reduce((sum, probability) => sum + probability, 0)
        const expectedScore = probabilities.reduce((sum, probability, index) => (
            sum + (probability * analysis[index].score)
        ), 0)

        assert.ok(Math.abs(probabilities[0] - probabilities[1]) < 1e-12)
        const normalisedSkill = (skill - 1) / 999
        const uniformWinShare = 2 / analysis.length
        const targetWinProbability = uniformWinShare +
            ((1 - uniformWinShare) * normalisedSkill)
        assert.ok(Math.abs(winProbability - targetWinProbability) < 1e-12)
        assert.ok(winProbability + 1e-12 >= previousWinProbability)
        assert.ok(lossProbability <= previousLossProbability + 1e-12)
        assert.ok(expectedScore + 1e-9 >= previousExpectedScore)
        previousWinProbability = winProbability
        previousLossProbability = lossProbability
        previousExpectedScore = expectedScore
    }

    const maximumSkill = Array.from(harness.context.moveSelectionProbabilities(analysis, 1000))
    assert.deepEqual(maximumSkill.slice(0, 3), [0.5, 0.5, 0])
    assert.ok(maximumSkill.slice(2).every(probability => probability === 0))
})

test("more instant-loss alternatives create more aggregate mistake probability", () => {
    const harness = createHarness()
    const lossCounts = [1, 2, 5, 10, 20, 26]
    const skills = [1, 100, 300, 500, 700, 900, 1000]
    const lossMassBySkill = new Map()

    for (const skill of skills) {
        let previousLossMass = -1
        const lossesAtThisSkill = []
        for (const lossCount of lossCounts) {
            const analysis = [
                {move: UNIQUE_MOVE_SHAPES[0], score: 0},
                ...UNIQUE_MOVE_SHAPES.slice(1, lossCount + 1).map(move => ({move, score: -10000}))
            ]
            const probabilities = Array.from(harness.context.moveSelectionProbabilities(analysis, skill))
            const lossProbabilities = probabilities.slice(1)
            const lossMass = lossProbabilities.reduce((sum, probability) => sum + probability, 0)
            const normalisedSkill = (skill - 1) / 999
            const expectedLossMass = (1 - normalisedSkill) * (lossCount / (lossCount + 1))

            assert.ok(Math.abs(lossMass - expectedLossMass) < 1e-12)
            assert.ok(lossMass > previousLossMass || skill === 1000)
            assert.ok(lossProbabilities.every(probability => (
                Math.abs(probability - lossProbabilities[0]) < 1e-12
            )))
            previousLossMass = lossMass
            lossesAtThisSkill.push(lossMass)
        }
        lossMassBySkill.set(skill, lossesAtThisSkill)
    }

    for (const lossIndex of lossCounts.keys()) {
        const masses = skills.map(skill => lossMassBySkill.get(skill)[lossIndex])
        masses.slice(1).forEach((mass, index) => assert.ok(mass <= masses[index] + 1e-12))
    }

    assert.ok(lossMassBySkill.get(300)[4] > 0.65)
    assert.equal(lossMassBySkill.get(1000)[5], 0)
})

test("real tactical positions retain meaningful instant-loss probability", () => {
    const harness = createHarness()
    const board = ["☗", "☗", "", "", "", "", "", "", ""]
    const analysis = engine.analyzePosition(board, {maxDepth: 2}).analysis
    const immediateWins = analysis.filter(move => move.score >= 9000)
    const instantLosses = analysis.filter(move => move.score <= -9000)
    const unresolved = analysis.filter(move => Math.abs(move.score) < 9000)

    assert.equal(analysis.length, 23)
    assert.equal(immediateWins.length, 1)
    assert.equal(unresolved.length, 3)
    assert.equal(instantLosses.length, 19)

    const expectedRanges = new Map([
        [300, [0.40, 0.50]],
        [500, [0.20, 0.28]],
        [700, [0.06, 0.11]],
        [900, [0.005, 0.02]]
    ])
    for (const [skill, [minimum, maximum]] of expectedRanges) {
        const probabilities = Array.from(harness.context.moveSelectionProbabilities(analysis, skill))
        const lossMass = probabilities.reduce((sum, probability, index) => (
            analysis[index].score <= -9000 ? sum + probability : sum
        ), 0)
        assert.ok(lossMass >= minimum && lossMass <= maximum, `skill ${skill}: ${lossMass}`)
    }
})

test("outcome probabilities stay numerically smooth at very high skill", () => {
    const harness = createHarness()
    const board = ["", "", "", "✂", "", "☗", "", "", ""]
    const analysis = engine.analyzePosition(board, {maxDepth: 2}).analysis
    const lossCount = analysis.filter(move => move.score <= -9000).length
    let previousLossMass = Infinity
    let previousExpectedScore = -Infinity

    for (let skill = 950; skill <= 1000; skill += 1) {
        const probabilities = Array.from(harness.context.moveSelectionProbabilities(analysis, skill))
        const lossMass = probabilities.reduce((sum, probability, index) => (
            analysis[index].score <= -9000 ? sum + probability : sum
        ), 0)
        const expectedLossMass = (1 - ((skill - 1) / 999)) * (lossCount / analysis.length)
        const expectedScore = probabilities.reduce((sum, probability, index) => (
            sum + (probability * analysis[index].score)
        ), 0)

        assert.ok(Math.abs(lossMass - expectedLossMass) < 1e-12, `skill ${skill}: ${lossMass}`)
        assert.ok(lossMass <= previousLossMass + 1e-15)
        assert.ok(expectedScore + 1e-9 >= previousExpectedScore, `skill ${skill}: ${expectedScore}`)
        previousLossMass = lossMass
        previousExpectedScore = expectedScore
    }
})

test("malformed analysis entries are never selected", () => {
    const harness = createHarness()
    const analysis = [
        {move: [0, "☗"], score: 10},
        {move: [1, "🗋"], score: NaN},
        {move: [2, "✂"], score: Infinity},
        {move: [3, "☗"], score: Symbol("bad")},
        {move: [4, "🗋"], score: null},
        {move: [5, "✂"], score: "10000"},
        {move: [6, "☗"], score: false},
        {move: [99, "🗋"], score: 20},
        {move: [7, "unknown"], score: 30}
    ]
    const probabilities = Array.from(harness.context.moveSelectionProbabilities(analysis, 1))

    assert.deepEqual(probabilities, [1, 0, 0, 0, 0, 0, 0, 0, 0])
})

test("duplicate analysis entries do not manufacture extra alternatives", () => {
    const harness = createHarness()
    const original = [
        {move: [0, "☗"], score: 0},
        {move: [1, "🗋"], score: -10000}
    ]
    const duplicated = [...original, {move: [1, "🗋"], score: -10000}]
    const previous = [
        {move: [1, "🗋"], score: 10},
        {move: [0, "☗"], score: 0}
    ]

    for (const blend of [0, 0.5, 1]) {
        const originalProbabilities = Array.from(harness.context.moveSelectionProbabilities(
            original, 300, previous, blend
        ))
        const duplicatedProbabilities = Array.from(harness.context.moveSelectionProbabilities(
            duplicated, 300, previous, blend
        ))

        assert.deepEqual(duplicatedProbabilities.slice(0, 2), originalProbabilities)
        assert.equal(duplicatedProbabilities[2], 0)
    }

    const conflictingDuplicates = [
        original[0],
        original[1],
        {move: [1, "🗋"], score: 10000}
    ]
    const canonicalAnalysis = [original[0], conflictingDuplicates[2]]
    const canonicalProbabilities = Array.from(harness.context.moveSelectionProbabilities(
        canonicalAnalysis, 300, previous, 0.5
    ))
    const conflictingProbabilities = Array.from(harness.context.moveSelectionProbabilities(
        conflictingDuplicates, 300, previous, 0.5
    ))

    assert.equal(conflictingProbabilities[0], canonicalProbabilities[0])
    assert.equal(conflictingProbabilities[1], 0)
    assert.equal(conflictingProbabilities[2], canonicalProbabilities[1])
})

test("a stale worker reply cannot mutate a restarted two-player game", () => {
    const harness = createHarness()
    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const oldWorker = harness.workers[0]
    const oldRequest = oldWorker.messages[0]

    harness.elements.twoplayer.dispatch("click")
    assert.equal(oldWorker.terminated, true)
    oldWorker.deliver({requestId: oldRequest.requestId, analysis: [{move: [4, "🗋"], score: 10}]})

    assert.deepEqual(harness.cells.map(cell => cell.textContent), Array(9).fill(""))
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
})

test("rapid O-first restarts queue exactly one AI request", () => {
    const harness = createHarness()
    harness.elements.restartO.dispatch("click")
    harness.elements.restartO.dispatch("click")
    harness.elements.restartO.dispatch("click")
    harness.runTimers(0)

    const postedMessages = harness.workers.flatMap(worker => worker.messages)
    assert.equal(postedMessages.length, 1)
    assert.equal(harness.workers.at(-1).messages.length, 1)
})

test("worker errors fall back to a legal move instead of locking the turn", () => {
    const harness = createHarness()
    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const failedWorker = harness.workers[0]

    assert.equal(failedWorker.fail(), true)
    assert.equal(failedWorker.terminated, true)
    assert.equal(harness.cells[0].textContent, "🗋")
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
})

test("a maximum-skill fallback takes an available immediate win", () => {
    const harness = createHarness()
    harness.elements.botSkill.value = "1000"
    harness.elements.botSkill.dispatch("input")
    harness.elements.restartO.dispatch("click")
    harness.cells[0].textContent = "☗"
    harness.cells[1].textContent = "☗"
    harness.runTimers(0)

    harness.workers.at(-1).fail()

    assert.equal(harness.cells[2].textContent, "☗")
    assert.equal(harness.elements.turnTracker.textContent, "O wins!")
})

test("a wedged worker is replaced after the watchdog deadline", () => {
    const harness = createHarness()
    harness.cells[0].dispatch("click")
    harness.runTimers(0)
    const wedgedWorker = harness.workers[0]

    harness.runTimers(2000)
    assert.equal(wedgedWorker.terminated, true)
    assert.equal(harness.cells[0].textContent, "🗋")
    assert.equal(harness.elements.turnTracker.textContent, "X's turn")
})
