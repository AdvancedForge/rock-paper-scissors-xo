const assert = require("node:assert/strict")
const {readFileSync} = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const uiSource = readFileSync(path.join(__dirname, "..", "rpsxo.js"), "utf8")

test("every HTML entry point declares UTF-8 before page content", () => {
    for (const filename of ["index.html", "playground.html", "tutorial.html"]) {
        const html = readFileSync(path.join(__dirname, "..", filename), "utf8")
        assert.match(html, /<head>\s*<meta charset="UTF-8">/i, filename)
    }
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

function createHarness(randomValue = 0) {
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
    const context = {
        Array,
        clearTimeout,
        console: {error() {}, warn() {}},
        document: {
            querySelectorAll: selector => selector === ".cell" ? cells : [],
            getElementById: id => elements[id] ?? null
        },
        localforage: {
            getItem: async () => null,
            setItem: async (_key, value) => { savedUsers.push({...value}) }
        },
        Math: Object.create(Math),
        Promise,
        setTimeout,
        Worker: FakeWorker
    }
    context.Math.random = () => randomValue
    vm.createContext(context)
    vm.runInContext(uiSource, context)

    return {cells, elements, runTimers, savedUsers, timers, workers}
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
