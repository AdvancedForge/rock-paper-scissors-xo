/*
 * Move-selection policy for RPSXO.
 *
 * Rockfish reports a search score for every legal move. This turns those
 * scores into a probability distribution over moves, so a single engine can
 * cover the whole skill range from "plays almost randomly" to "always the
 * best move it can prove".
 *
 * This module is deliberately free of DOM, storage and worker concerns: it is
 * pure policy arithmetic over an analysis, which keeps the difficulty curve
 * testable on its own.
 */
(function initialisePolicy(globalScope) {
    "use strict"

    const rules = (globalScope && globalScope.RpsxoRules) ||
        (typeof require === "function" ? require("./rules") : null)
    if (!rules) throw new Error("RPSXO policy requires rules.js to load first")

    // Search scores fall into three qualitatively different bands: a proven
    // win, an unresolved heuristic value, and a proven loss.
    const PROVEN_SCORE = 9000
    // Two heuristic scores this far apart are worth skipping ranks, so a
    // clearly worse move is not chosen just because it sits next to a slightly
    // better one.
    const HEURISTIC_SCORE_PER_RANK = 40
    const MAX_HEURISTIC_GAP_RANKS = 4

    const normaliseSkill = rules.normaliseSkill

    function outcomeBand(score) {
        if (score >= PROVEN_SCORE) return 1
        if (score <= -PROVEN_SCORE) return -1
        return 0
    }

    function analysedMoveScore(move) {
        return typeof move?.score === "number" && Number.isFinite(move.score)
            ? move.score
            : null
    }

    function analysedMoveKey(move) {
        return Array.isArray(move?.move) ? `${move.move[0]}|${move.move[1]}` : null
    }

    function isAnalysedMoveCandidate(move) {
        return Array.isArray(move?.move) &&
            Number.isInteger(move.move[0]) && move.move[0] >= 0 &&
            move.move[0] < rules.BOARD_CELLS &&
            rules.MOVES.includes(move.move[1]) && analysedMoveScore(move) !== null
    }

    // Ranks candidates by score, then collapses duplicates so a repeated move
    // cannot manufacture extra alternatives for the weighted draw below.
    function rankedAnalysedMoves(analysedMoves) {
        if (!Array.isArray(analysedMoves) || analysedMoves.length === 0) return []

        const seenMoveKeys = new Set()
        return analysedMoves.map((move, index) => (
            {index, move, score: analysedMoveScore(move)}
        )).filter(candidate => isAnalysedMoveCandidate(candidate.move))
            .sort((first, second) => second.score - first.score || first.index - second.index)
            .filter(candidate => {
                const key = analysedMoveKey(candidate.move)
                if (seenMoveKeys.has(key)) return false
                seenMoveKeys.add(key)
                return true
            })
    }

    function rankedMoveProbabilities(analysedMoves, skill) {
        const rankedMoves = rankedAnalysedMoves(analysedMoves)
        if (rankedMoves.length === 0) return []

        const normalisedSkill = normaliseSkill(skill)
        const continuation = Math.cbrt(1 - normalisedSkill)

        // A geometric distribution gives every rank some probability below skill
        // 1000. Exact score ties share the mass of all ranks occupied by that tie,
        // so symmetric moves remain equally likely without their count swamping a
        // better or worse score group.
        const weights = Array(analysedMoves.length).fill(0)
        let rank = 0
        let previousGroupScore = null
        for (let groupStart = 0; groupStart < rankedMoves.length;) {
            let groupEnd = groupStart + 1
            while (groupEnd < rankedMoves.length &&
                rankedMoves[groupEnd].score === rankedMoves[groupStart].score) {
                groupEnd += 1
            }

            const groupSize = groupEnd - groupStart
            const groupScore = rankedMoves[groupStart].score
            if (previousGroupScore !== null &&
                outcomeBand(previousGroupScore) === 0 && outcomeBand(groupScore) === 0) {
                const heuristicGapRanks = Math.min(
                    MAX_HEURISTIC_GAP_RANKS,
                    Math.floor((previousGroupScore - groupScore) / HEURISTIC_SCORE_PER_RANK)
                )
                rank += Math.max(0, heuristicGapRanks)
            }

            let groupWeight = 0
            for (let offset = 0; offset < groupSize; offset += 1) {
                groupWeight += Math.pow(continuation, rank + offset)
            }
            for (let index = groupStart; index < groupEnd; index += 1) {
                weights[rankedMoves[index].index] = groupWeight / groupSize
            }
            rank += groupSize
            previousGroupScore = groupScore
            groupStart = groupEnd
        }

        // As skill rises, Rockfish should increasingly choose from the best
        // available outcome band while keeping ranked variety inside that band.
        const bestOutcomeBand = outcomeBand(rankedMoves[0].score)
        const bestBandMoves = rankedMoves.filter(
            candidate => outcomeBand(candidate.score) === bestOutcomeBand
        )
        const bestBandIndexes = new Set(bestBandMoves.map(candidate => candidate.index))
        const bestBandWeight = bestBandMoves.reduce(
            (sum, candidate) => sum + weights[candidate.index], 0
        )
        const otherBandWeight = rankedMoves.reduce((sum, candidate) => (
            bestBandIndexes.has(candidate.index) ? sum : sum + weights[candidate.index]
        ), 0)

        // Skill controls how much Rockfish insists on the best known outcome
        // band. The remaining mass respects how many legal alternatives exist:
        // one safe move among twenty losing moves is therefore easier to miss
        // than one safe move among two. Skill 1 stays uniform and skill 1000
        // stays exact.
        const uniformBestBandShare = bestBandMoves.length / rankedMoves.length
        const targetOtherBandProbability = (1 - uniformBestBandShare) * (1 - normalisedSkill)
        const targetBestBandProbability = 1 - targetOtherBandProbability
        const probabilities = weights.map((weight, index) => {
            if (bestBandIndexes.has(index)) {
                return bestBandWeight > 0
                    ? targetBestBandProbability * (weight / bestBandWeight)
                    : 0
            }
            return otherBandWeight > 0
                ? targetOtherBandProbability * (weight / otherBandWeight)
                : 0
        })

        return normaliseProbabilities(probabilities)
    }

    function normaliseProbabilities(probabilities) {
        const total = probabilities.reduce((sum, probability) => sum + probability, 0)
        return total > 0 ? probabilities.map(probability => probability / total) : probabilities
    }

    // Rockfish searches in depth tiers. Crossing a tier boundary would make
    // difficulty jump, so the policy cross-fades the current depth's
    // distribution with the previous tier's instead of switching abruptly.
    function moveSelectionProbabilities(analysedMoves, skill, previousAnalysis = null, depthBlend = 1) {
        const currentProbabilities = rankedMoveProbabilities(analysedMoves, skill)
        const blend = typeof depthBlend === "number" && Number.isFinite(depthBlend)
            ? Math.min(1, Math.max(0, depthBlend))
            : 1
        if (!Array.isArray(previousAnalysis) || previousAnalysis.length === 0 || blend >= 1) {
            return currentProbabilities
        }

        const previousProbabilities = rankedMoveProbabilities(previousAnalysis, skill)
        const canonicalCurrentIndexes = new Set(
            rankedAnalysedMoves(analysedMoves).map(candidate => candidate.index)
        )
        const previousByMove = new Map()
        previousAnalysis.forEach((move, index) => {
            const key = analysedMoveKey(move)
            const probability = previousProbabilities[index]
            if (key !== null && probability > 0) {
                previousByMove.set(key, (previousByMove.get(key) || 0) + probability)
            }
        })

        // Join on move identity, not array position, because the two depths can
        // return the same moves in a different order.
        const blended = currentProbabilities.map((probability, index) => {
            if (!canonicalCurrentIndexes.has(index)) return 0
            const previousProbability = previousByMove.get(
                analysedMoveKey(analysedMoves[index])
            ) || 0
            return (blend * probability) + ((1 - blend) * previousProbability)
        })
        const total = blended.reduce((sum, probability) => sum + probability, 0)
        return total > 0 ? blended.map(probability => probability / total) : currentProbabilities
    }

    function skillBasedMovePick(analysedMoves, skill, previousAnalysis = null, depthBlend = 1) {
        const probabilities = moveSelectionProbabilities(
            analysedMoves, skill, previousAnalysis, depthBlend
        )
        if (probabilities.length === 0) return null

        let cumulativeProbability = 0
        let fallbackIndex = -1
        const randomNumber = Math.random()
        for (let index = 0; index < analysedMoves.length; index += 1) {
            if (probabilities[index] > 0) fallbackIndex = index
            cumulativeProbability += probabilities[index]
            if (randomNumber < cumulativeProbability) return analysedMoves[index]
        }

        return fallbackIndex >= 0 ? analysedMoves[fallbackIndex] : null
    }

    const api = {
        PROVEN_SCORE,
        analysedMoveKey,
        moveSelectionProbabilities,
        outcomeBand,
        rankedMoveProbabilities,
        skillBasedMovePick
    }

    if (typeof module !== "undefined" && module.exports) module.exports = api
    if (globalScope) globalScope.RpsxoPolicy = api
})(typeof globalThis !== "undefined" ? globalThis : null)