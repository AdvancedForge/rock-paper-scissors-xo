const assert = require("node:assert/strict")
const test = require("node:test")

const engine = require("../rockfish")
const policy = require("../policy")
const rules = require("../rules")

const moveSelectionProbabilities = policy.moveSelectionProbabilities
const UNIQUE_MOVE_SHAPES = Array.from({length: 9}, (_, cell) => (
    [rules.ROCK, rules.PAPER, rules.SCISSORS].map(piece => [cell, piece])
)).flat()
test("move-choice weighting strengthens smoothly without premature determinism", () => {
        const analysis = [
        {move: [0, "☗"], score: 30},
        {move: [1, "🗋"], score: 20},
        {move: [2, "✂"], score: 10}
    ]
    const skills = [1, 100, 300, 500, 700, 900, 1000]
    const probabilitySets = skills.map(skill => (
        Array.from(moveSelectionProbabilities(analysis, skill))
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
        const closeScores = [
        {move: [0, "☗"], score: 1},
        {move: [1, "🗋"], score: 0}
    ]
    const distantScores = [
        {move: [0, "☗"], score: 800},
        {move: [1, "🗋"], score: -800}
    ]
    const closeProbabilities = Array.from(moveSelectionProbabilities(closeScores, 700))
    const distantProbabilities = Array.from(moveSelectionProbabilities(distantScores, 700))

    assert.ok(closeProbabilities[1] > 0.3)
    assert.ok(distantProbabilities[1] < 0.15)
    assert.ok(distantProbabilities[1] < closeProbabilities[1] / 2)
})

test("depth cross-fades join moves by identity and mix probability vectors", () => {
        const currentAnalysis = [
        {move: [0, "☗"], score: 20},
        {move: [1, "🗋"], score: 10}
    ]
    const previousAnalysis = [
        {move: [1, "🗋"], score: 20},
        {move: [0, "☗"], score: 10}
    ]

    const previousOnly = Array.from(moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, 0
    ))
    const halfway = Array.from(moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, 0.5
    ))
    const currentOnly = Array.from(moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, 1
    ))
    const malformedBlend = Array.from(moveSelectionProbabilities(
        currentAnalysis, 500, previousAnalysis, null
    ))

    assert.ok(previousOnly[1] > previousOnly[0])
    assert.ok(currentOnly[0] > currentOnly[1])
    assert.deepEqual(malformedBlend, currentOnly)
    assert.ok(Math.abs(halfway[0] - 0.5) < 1e-12)
    assert.ok(Math.abs(halfway[1] - 0.5) < 1e-12)
})

test("a one-point skill change cross-fades instead of jumping depth policies", () => {
        const board = ["☗", "🗋", "☗", "✂", "", "✂", "🗋", "✂", "🗋"]
    const referenceScores = new Map(engine.analyzePosition(board, {maxDepth: 10}).analysis.map(entry => (
        [JSON.stringify(entry.move), entry.score]
    )))
    const expectedReferenceScore = (result, skill) => {
        const probabilities = Array.from(moveSelectionProbabilities(
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
        const probabilities = Array.from(moveSelectionProbabilities(analysis, skill))
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

    const maximumSkill = Array.from(moveSelectionProbabilities(analysis, 1000))
    assert.deepEqual(maximumSkill.slice(0, 3), [0.5, 0.5, 0])
    assert.ok(maximumSkill.slice(2).every(probability => probability === 0))
})

test("more instant-loss alternatives create more aggregate mistake probability", () => {
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
            const probabilities = Array.from(moveSelectionProbabilities(analysis, skill))
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
        const probabilities = Array.from(moveSelectionProbabilities(analysis, skill))
        const lossMass = probabilities.reduce((sum, probability, index) => (
            analysis[index].score <= -9000 ? sum + probability : sum
        ), 0)
        assert.ok(lossMass >= minimum && lossMass <= maximum, `skill ${skill}: ${lossMass}`)
    }
})

test("outcome probabilities stay numerically smooth at very high skill", () => {
        const board = ["", "", "", "✂", "", "☗", "", "", ""]
    const analysis = engine.analyzePosition(board, {maxDepth: 2}).analysis
    const lossCount = analysis.filter(move => move.score <= -9000).length
    let previousLossMass = Infinity
    let previousExpectedScore = -Infinity

    for (let skill = 950; skill <= 1000; skill += 1) {
        const probabilities = Array.from(moveSelectionProbabilities(analysis, skill))
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
    const probabilities = Array.from(moveSelectionProbabilities(analysis, 1))

    assert.deepEqual(probabilities, [1, 0, 0, 0, 0, 0, 0, 0, 0])
})

test("duplicate analysis entries do not manufacture extra alternatives", () => {
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
        const originalProbabilities = Array.from(moveSelectionProbabilities(
            original, 300, previous, blend
        ))
        const duplicatedProbabilities = Array.from(moveSelectionProbabilities(
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
    const canonicalProbabilities = Array.from(moveSelectionProbabilities(
        canonicalAnalysis, 300, previous, 0.5
    ))
    const conflictingProbabilities = Array.from(moveSelectionProbabilities(
        conflictingDuplicates, 300, previous, 0.5
    ))

    assert.equal(conflictingProbabilities[0], canonicalProbabilities[0])
    assert.equal(conflictingProbabilities[1], 0)
    assert.equal(conflictingProbabilities[2], canonicalProbabilities[1])
})
