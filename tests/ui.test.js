const assert = require("node:assert/strict")
const {readFileSync} = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const engine = require("../rockfish")
const uiSource = readFileSync(path.join(__dirname, "..", "rpsxo.js"), "utf8")

test("every HTML entry point declares UTF-8 before page content", () => {
    for (const filename of ["index.html", "playground.html", "tutorial.html"]) {
        const html = readFileSync(path.join(__dirname, "..", filename), "utf8")
        assert.match(html, /<head>\s*<meta charset="UTF-8">/i, filename)
    }

    const playground = readFileSync(path.join(__dirname, "..", "playground.html"), "utf8")
    assert.match(playground, /<script src="rockfish\.js"><\/script>\s*<script src="rpsxo\.js"><\/script>/)
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
            getItem: async () => null,
            setItem: async (_key, value) => { savedUsers.push({...value}) }
        },
        Math: Object.create(Math),
        location: {protocol: options.protocol ?? "https:"},
        Promise,
        setTimeout,
        Worker: FakeWorker
    }
    if (options.Rockfish) context.Rockfish = options.Rockfish
    context.Math.random = () => randomValue
    vm.createContext(context)
    vm.runInContext(uiSource, context)

    return {cells, consoleErrors, context, elements, runTimers, savedUsers, timers, workers}
}

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
        {move: [0, "☗"], score: 10000},
        {move: [1, "🗋"], score: 10000},
        {move: [2, "✂"], score: 20},
        ...Array.from({length: 16}, (_, index) => ({move: [index % 9, "☗"], score: -10000}))
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
        const tacticalAccuracy = 1 - Math.pow(1 - normalisedSkill, 3)
        assert.ok(winProbability + 1e-12 >= tacticalAccuracy)
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

test("obvious tactical moves improve on a deliberate skill curve", () => {
    const harness = createHarness()
    const analysis = [
        {move: [0, "☗"], score: 10000},
        ...Array.from({length: 20}, (_, index) => ({move: [index % 9, "🗋"], score: -10000}))
    ]
    const expectedMinimums = new Map([
        [100, 0.26],
        [300, 0.65],
        [500, 0.87],
        [700, 0.97],
        [900, 0.998]
    ])

    for (const [skill, expectedMinimum] of expectedMinimums) {
        const probabilities = Array.from(harness.context.moveSelectionProbabilities(analysis, skill))
        assert.ok(probabilities[0] >= expectedMinimum, `skill ${skill}: ${probabilities[0]}`)
        assert.ok(probabilities[0] < 1)
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
