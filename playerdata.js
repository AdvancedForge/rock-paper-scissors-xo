/*
 * Local, versioned player data for RPSXO.
 *
 * This module records complete single-player timelines for context and creates
 * training examples only from accepted human moves. Nothing is uploaded and
 * nothing in this file trains or changes a model.
 */
(function initialisePlayerData(globalScope) {
    "use strict"

    const DATA_SCHEMA_VERSION = 1
    const FEATURE_SCHEMA_VERSION = 1
    const RULES_VERSION = "classic-v1"
    const ENGINE_VERSION = "rockfish-v1"
    const POLICY_VERSION = "weighted-v2"
    const PROFILE_KEY = "profile"
    const META_KEY = "manifest"
    const JOURNAL_KEY = "pending-transaction"
    const GAME_KEY_PREFIX = "game:"
    const MAX_GAMES = 500
    const MAX_DECISIONS = 10000
    const MAX_GAME_PLIES = 256
    const HISTORY_LENGTH = 16
    const ACTIVE_GAME_STALE_MS = 12 * 60 * 60 * 1000

    // ASCII escapes keep the page/worker/storage contract independent of the
    // charset used by a host serving these classic scripts.
    const ROCK = "\u2617"
    const PAPER = "\uD83D\uDDCB"
    const SCISSORS = "\u2702"
    const PIECES = ["", ROCK, PAPER, SCISSORS]
    const PIECE_NAMES = ["", "rock", "paper", "scissors"]
    const PIECE_CODES = {[ROCK]: 1, [PAPER]: 2, [SCISSORS]: 3}
    const WIN_LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ]

    function deepClone(value) {
        if (value === undefined) return undefined
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value)
            } catch (_error) {
                // JSON is sufficient for every persisted record in this module.
            }
        }
        return JSON.parse(JSON.stringify(value))
    }

    function finiteNonNegative(value, fallback = 0) {
        return typeof value === "number" && Number.isFinite(value) && value >= 0
            ? Math.floor(value)
            : fallback
    }

    function clampSkill(value) {
        const numericValue = Number(value)
        if (!Number.isFinite(numericValue)) return 300
        return Math.min(1000, Math.max(1, Math.round(numericValue)))
    }

    function pieceCode(piece) {
        if (Number.isInteger(piece) && piece >= 1 && piece <= 3) return piece
        return PIECE_CODES[piece] || 0
    }

    function encodeBoard(board) {
        if (!Array.isArray(board) || board.length !== 9) {
            throw new Error("A RPSXO board must contain exactly 9 cells")
        }

        let state = 0
        board.forEach((piece, cell) => {
            let code = 0
            if (piece !== "" && piece !== null && piece !== undefined && piece !== 0) {
                code = pieceCode(piece)
                if (!code) throw new Error("Unknown RPSXO piece")
            }
            state |= code << (cell * 2)
        })
        return state
    }

    function decodeBoard(state) {
        if (!Number.isInteger(state) || state < 0 || state >= (1 << 18)) {
            throw new Error("Invalid encoded RPSXO board")
        }
        return Array.from({length: 9}, (_, cell) => PIECES[(state >> (cell * 2)) & 3])
    }

    function codeAt(state, cell) {
        return (state >> (cell * 2)) & 3
    }

    function encodeAction(cell, piece) {
        const code = pieceCode(piece)
        if (!Number.isInteger(cell) || cell < 0 || cell > 8 || !code) {
            throw new Error("Invalid RPSXO action")
        }
        return (cell * 3) + code - 1
    }

    function decodeAction(actionId) {
        if (!Number.isInteger(actionId) || actionId < 0 || actionId > 26) {
            throw new Error("Invalid RPSXO action id")
        }
        return [Math.floor(actionId / 3), PIECES[(actionId % 3) + 1]]
    }

    function nextPieceCode(code) {
        return code === 3 ? 1 : code + 1
    }

    function isLegalAction(state, actionId) {
        if (!Number.isInteger(state) || state < 0 || state >= (1 << 18) ||
            !Number.isInteger(actionId) || actionId < 0 || actionId > 26) {
            return false
        }
        const cell = Math.floor(actionId / 3)
        const code = (actionId % 3) + 1
        const occupied = codeAt(state, cell)
        return occupied === 0 || code === nextPieceCode(occupied)
    }

    function legalActionMask(boardOrState) {
        const state = Array.isArray(boardOrState) ? encodeBoard(boardOrState) : boardOrState
        let mask = 0
        for (let actionId = 0; actionId < 27; actionId += 1) {
            if (isLegalAction(state, actionId)) mask |= 1 << actionId
        }
        return mask >>> 0
    }

    function countMaskBits(mask) {
        let value = mask >>> 0
        let count = 0
        while (value) {
            value &= value - 1
            count += 1
        }
        return count
    }

    function applyAction(state, actionId) {
        if (!isLegalAction(state, actionId)) throw new Error("Illegal RPSXO action")
        const cell = Math.floor(actionId / 3)
        const code = (actionId % 3) + 1
        const shift = cell * 2
        return (state & ~(3 << shift)) | (code << shift)
    }

    function winningLine(state) {
        return WIN_LINES.find(line => {
            const code = codeAt(state, line[0])
            return code !== 0 && codeAt(state, line[1]) === code &&
                codeAt(state, line[2]) === code
        }) || null
    }

    function createMemoryStorage(seed = {}) {
        const records = new Map(Object.entries(deepClone(seed)))
        return {
            async getItem(key) {
                return records.has(key) ? deepClone(records.get(key)) : null
            },
            async setItem(key, value) {
                records.set(key, deepClone(value))
                return deepClone(value)
            },
            async removeItem(key) {
                records.delete(key)
            },
            async keys() {
                return [...records.keys()]
            },
            async clear() {
                records.clear()
            }
        }
    }

    function defaultMeta(now) {
        return {
            schemaVersion: DATA_SCHEMA_VERSION,
            featureVersion: FEATURE_SCHEMA_VERSION,
            activeGameId: null,
            gameIds: [],
            revision: 0,
            updatedAt: now
        }
    }

    function emptyPieceCells() {
        return {
            rock: Array(9).fill(0),
            paper: Array(9).fill(0),
            scissors: Array(9).fill(0)
        }
    }

    function defaultProfile(now) {
        return {
            schemaVersion: DATA_SCHEMA_VERSION,
            id: "local-player",
            createdAt: now,
            updatedAt: now,
            lifetime: {
                gamesStarted: 0,
                gamesCompleted: 0,
                wins: 0,
                losses: 0,
                abandoned: 0,
                moves: 0,
                pieces: {rock: 0, paper: 0, scissors: 0},
                cellsByPiece: emptyPieceCells(),
                openings: Array(27).fill(0),
                replacements: 0,
                emptyPlacements: 0,
                winningMoves: 0
            },
            legacy: {
                importedAt: null,
                checkedAt: null,
                rating: null,
                bestRating: null,
                ratingHistory: null,
                WLR: null,
                WLA: null
            }
        }
    }

    function normaliseCountArray(value, length) {
        return Array.from({length}, (_, index) => finiteNonNegative(value?.[index]))
    }

    function normaliseProfile(value, now) {
        const profile = defaultProfile(now)
        if (!value || typeof value !== "object") return profile
        profile.createdAt = finiteNonNegative(value.createdAt, now)
        profile.updatedAt = finiteNonNegative(value.updatedAt, now)

        const lifetime = value.lifetime || {}
        for (const field of [
            "gamesStarted", "gamesCompleted", "wins", "losses", "abandoned",
            "moves", "replacements", "emptyPlacements", "winningMoves"
        ]) {
            profile.lifetime[field] = finiteNonNegative(lifetime[field])
        }
        for (const name of ["rock", "paper", "scissors"]) {
            profile.lifetime.pieces[name] = finiteNonNegative(lifetime.pieces?.[name])
            profile.lifetime.cellsByPiece[name] = normaliseCountArray(
                lifetime.cellsByPiece?.[name], 9
            )
        }
        profile.lifetime.openings = normaliseCountArray(lifetime.openings, 27)

        if (value.legacy && typeof value.legacy === "object") {
            profile.legacy = deepClone({...profile.legacy, ...value.legacy})
        }
        return profile
    }

    function normaliseMeta(value, now) {
        const meta = defaultMeta(now)
        if (!value || typeof value !== "object") return meta
        meta.activeGameId = typeof value.activeGameId === "string" ? value.activeGameId : null
        meta.gameIds = Array.isArray(value.gameIds)
            ? [...new Set(value.gameIds.filter(id => typeof id === "string"))]
            : []
        meta.revision = finiteNonNegative(value.revision)
        meta.updatedAt = finiteNonNegative(value.updatedAt, now)
        return meta
    }

    function migrateLegacyProfile(profile, legacyUser, now) {
        profile.legacy.checkedAt = now
        if (!legacyUser || typeof legacyUser !== "object") return false

        const pieceFields = {rock: "R", paper: "P", scissors: "S"}
        for (const [name, legacyField] of Object.entries(pieceFields)) {
            const count = finiteNonNegative(legacyUser[legacyField])
            profile.lifetime.pieces[name] = Math.max(profile.lifetime.pieces[name], count)
            for (let cell = 0; cell < 9; cell += 1) {
                const legacyCellCount = finiteNonNegative(legacyUser[`${legacyField}${cell}`])
                profile.lifetime.cellsByPiece[name][cell] = Math.max(
                    profile.lifetime.cellsByPiece[name][cell], legacyCellCount
                )
            }
        }
        const migratedMoves = Object.values(profile.lifetime.pieces)
            .reduce((sum, count) => sum + count, 0)
        profile.lifetime.moves = Math.max(profile.lifetime.moves, migratedMoves)
        profile.legacy = {
            importedAt: now,
            checkedAt: now,
            rating: Number.isFinite(legacyUser.rating) ? legacyUser.rating : null,
            bestRating: Number.isFinite(legacyUser.bestRating) ? legacyUser.bestRating : null,
            ratingHistory: Array.isArray(legacyUser.ratingHistory)
                ? deepClone(legacyUser.ratingHistory)
                : null,
            WLR: Array.isArray(legacyUser.WLR) ? deepClone(legacyUser.WLR) : null,
            WLA: Array.isArray(legacyUser.WLA) ? deepClone(legacyUser.WLA) : null
        }
        profile.updatedAt = now
        return true
    }

    function createStore(options = {}) {
        const now = typeof options.now === "function" ? options.now : () => Date.now()
        const makeId = typeof options.makeId === "function"
            ? options.makeId
            : () => {
                if (globalScope?.crypto?.randomUUID) return globalScope.crypto.randomUUID()
                return `game-${Date.now()}-${Math.random().toString(36).slice(2)}`
            }
        const sessionId = typeof options.sessionId === "string" && options.sessionId
            ? options.sessionId
            : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const lockManager = options.lockManager || globalScope?.navigator?.locks || null
        const warning = typeof options.warn === "function"
            ? options.warn
            : (...args) => globalScope?.console?.warn?.(...args)
        const memoryStorage = createMemoryStorage()
        const suppliedStorage = options.storage
        const hasPersistentStorage = suppliedStorage &&
            typeof suppliedStorage.getItem === "function" &&
            typeof suppliedStorage.setItem === "function" &&
            typeof suppliedStorage.removeItem === "function"
        let storage = hasPersistentStorage ? suppliedStorage : memoryStorage
        let storageMode = hasPersistentStorage ? "indexeddb" : "memory"
        let warned = false
        let legacyWarned = false
        let meta = defaultMeta(now())
        let profile = defaultProfile(now())
        const games = new Map()
        let initialization = null
        let operationQueue = Promise.resolve()

        function withStorageLock(task) {
            if (lockManager && typeof lockManager.request === "function") {
                return lockManager.request("rpsxo-player-data", task)
            }
            return task()
        }

        function warnOnce(error) {
            if (warned) return
            warned = true
            warning("RPSXO player data is using session memory", error)
        }

        async function seedMemoryStorage() {
            await memoryStorage.setItem(META_KEY, meta)
            await memoryStorage.setItem(PROFILE_KEY, profile)
            for (const game of games.values()) {
                await memoryStorage.setItem(`${GAME_KEY_PREFIX}${game.id}`, game)
            }
        }

        async function switchToMemory(error) {
            if (storageMode === "memory") return
            storage = memoryStorage
            storageMode = "memory"
            warnOnce(error)
            await seedMemoryStorage()
        }

        async function readItem(key) {
            try {
                return await storage.getItem(key)
            } catch (error) {
                await switchToMemory(error)
                return storage.getItem(key)
            }
        }

        async function writeItem(key, value) {
            try {
                return await storage.setItem(key, deepClone(value))
            } catch (error) {
                await switchToMemory(error)
                return storage.setItem(key, deepClone(value))
            }
        }

        async function removeItem(key) {
            try {
                return await storage.removeItem(key)
            } catch (error) {
                await switchToMemory(error)
                return storage.removeItem(key)
            }
        }

        async function listStorageKeys() {
            if (typeof storage.keys !== "function") return null
            try {
                const keys = await storage.keys()
                return Array.isArray(keys) ? keys : null
            } catch (error) {
                await switchToMemory(error)
                return storage.keys()
            }
        }

        async function completeJournal(journal) {
            if (!journal || typeof journal !== "object" ||
                !journal.meta || !journal.profile) return false
            if (journal.game && typeof journal.game.id === "string") {
                await writeItem(`${GAME_KEY_PREFIX}${journal.game.id}`, journal.game)
            }
            if (Array.isArray(journal.removedKeys)) {
                for (const key of journal.removedKeys) {
                    if (typeof key === "string") await removeItem(key)
                }
            }
            await writeItem(PROFILE_KEY, journal.profile)
            await writeItem(META_KEY, journal.meta)
            await removeItem(JOURNAL_KEY)
            return true
        }

        async function recoverPendingTransaction() {
            const journal = await readItem(JOURNAL_KEY)
            return completeJournal(journal)
        }

        async function commitState(game = null, removedKeys = []) {
            profile.updatedAt = now()
            meta.updatedAt = profile.updatedAt
            meta.revision = finiteNonNegative(meta.revision) + 1
            const journal = {
                schemaVersion: DATA_SCHEMA_VERSION,
                profile: deepClone(profile),
                meta: deepClone(meta),
                game: game ? deepClone(game) : null,
                removedKeys: [...new Set(removedKeys)]
            }
            // The one-record journal is the commit point. Startup can replay it
            // if navigation interrupts one of the following LocalForage writes.
            await writeItem(JOURNAL_KEY, journal)
            await completeJournal(journal)
        }

        function persistMetaAndProfile(removedKeys = []) {
            return commitState(null, removedKeys)
        }

        function persistGame(game, removedKeys = []) {
            return commitState(game, removedKeys)
        }

        function patchAbandonedOutcomes(game) {
            game.examples.forEach(example => {
                example.outcome = {
                    status: "abandoned",
                    valueForHuman: null,
                    pliesToEnd: null
                }
                example.training.outcomeEligible = false
            })
        }

        function isRecentForeignGame(game) {
            if (!game?.ownerId || game.ownerId === sessionId) return false
            const age = Math.max(0, now() - finiteNonNegative(game.updatedAt, now()))
            return age < ACTIVE_GAME_STALE_MS
        }

        async function recoverActiveGame() {
            if (!meta.activeGameId) return
            const game = games.get(meta.activeGameId)
            if (!game || game.status !== "in_progress") {
                meta.activeGameId = null
                await persistMetaAndProfile()
                return
            }
            const age = Math.max(0, now() - finiteNonNegative(game.updatedAt, now()))
            // A destination page can initialize between recordMove() and
            // finishGame(). Never infer abandonment merely because it shares
            // the same tab/session; explicit pagehide/restart handles normal
            // exits and age is the crash-recovery backstop.
            if (age < ACTIVE_GAME_STALE_MS) return

            meta.activeGameId = null
            if (!Array.isArray(game.moves) || game.moves.length === 0) {
                games.delete(game.id)
                meta.gameIds = meta.gameIds.filter(id => id !== game.id)
                await persistMetaAndProfile([`${GAME_KEY_PREFIX}${game.id}`])
                return
            }

            const timestamp = now()
            game.status = "abandoned"
            game.termination = "recovered"
            game.endedAt = timestamp
            game.updatedAt = timestamp
            patchAbandonedOutcomes(game)
            profile.lifetime.abandoned += 1
            await persistGame(game)
        }

        async function importLegacyIfNeeded() {
            if (profile.legacy?.checkedAt !== null &&
                profile.legacy?.checkedAt !== undefined) return false
            let legacyUser = null
            const legacyStorage = options.legacyStorage
            if (legacyStorage && typeof legacyStorage.getItem === "function") {
                try {
                    legacyUser = await legacyStorage.getItem("user")
                } catch (error) {
                    if (!legacyWarned) {
                        legacyWarned = true
                        warning("Could not import legacy RPSXO stats", error)
                    }
                    // A transient legacy-read failure must not become a
                    // permanent "already checked" marker.
                    return false
                }
            }
            migrateLegacyProfile(profile, legacyUser, now())
            return true
        }

        async function loadPersistedState() {
            const timestamp = now()
            const storedMeta = await readItem(META_KEY)
            const storedProfile = await readItem(PROFILE_KEY)
            meta = normaliseMeta(storedMeta, timestamp)
            profile = normaliseProfile(storedProfile, timestamp)
            games.clear()
            for (const gameId of meta.gameIds) {
                const game = await readItem(`${GAME_KEY_PREFIX}${gameId}`)
                if (game && typeof game === "object" && game.id === gameId &&
                    Array.isArray(game.moves) && Array.isArray(game.examples)) {
                    games.set(gameId, deepClone(game))
                }
            }
            meta.gameIds = meta.gameIds.filter(id => games.has(id))
        }

        async function initialise() {
            await recoverPendingTransaction()
            await loadPersistedState()
            const legacyChanged = await importLegacyIfNeeded()
            if (legacyChanged) await persistMetaAndProfile()
            await recoverActiveGame()
        }

        async function refreshPersistedState() {
            await recoverPendingTransaction()
            const storedMeta = await readItem(META_KEY)
            const storedRevision = finiteNonNegative(storedMeta?.revision)
            if (storedMeta && storedRevision === finiteNonNegative(meta.revision)) return
            await loadPersistedState()
        }

        function ensureReady() {
            if (!initialization) {
                initialization = withStorageLock(initialise).catch(async error => {
                    await switchToMemory(error)
                    warnOnce(error)
                })
            }
            return initialization
        }

        function enqueue(task) {
            const result = operationQueue.then(async () => {
                await ensureReady()
                return withStorageLock(async () => {
                    await refreshPersistedState()
                    return task()
                })
            })
            operationQueue = result.catch(error => {
                warnOnce(error)
            })
            return result
        }

        function snapshotMovePayload(value) {
            if (!value || typeof value !== "object") return null
            return {
                mode: value.mode,
                starter: value.starter,
                humanTurn: value.humanTurn,
                turn: value.turn,
                actor: value.actor,
                source: value.source,
                boardBefore: Array.isArray(value.boardBefore) ? [...value.boardBefore] : null,
                cell: value.cell,
                piece: value.piece,
                botSkill: value.botSkill
            }
        }

        function uniqueGameId() {
            let id = String(makeId())
            if (!id) id = `game-${now()}`
            let suffix = 1
            const base = id
            while (games.has(id)) {
                id = `${base}-${suffix}`
                suffix += 1
            }
            return id
        }

        function createGame(event, boardState, timestamp) {
            const id = uniqueGameId()
            const game = {
                schemaVersion: DATA_SCHEMA_VERSION,
                featureVersion: FEATURE_SCHEMA_VERSION,
                id,
                ownerId: sessionId,
                startedAt: timestamp,
                updatedAt: timestamp,
                endedAt: null,
                status: "in_progress",
                termination: null,
                settings: {
                    mode: "singleplayer",
                    starter: event.starter,
                    humanTurn: event.humanTurn,
                    rulesVersion: RULES_VERSION,
                    bot: {
                        id: "rockfish",
                        engineVersion: ENGINE_VERSION,
                        policyVersion: POLICY_VERSION,
                        skillAtStart: event.botSkill
                    }
                },
                initialBoard: boardState,
                lastBoard: boardState,
                totalPlies: 0,
                moves: [],
                examples: [],
                result: null,
                recording: {
                    stopped: false,
                    exclusions: []
                }
            }
            games.set(id, game)
            meta.gameIds.push(id)
            meta.activeGameId = id
            profile.lifetime.gamesStarted += 1
            return game
        }

        async function abandonActiveGame(reason) {
            const game = meta.activeGameId ? games.get(meta.activeGameId) : null
            if (!game || game.status !== "in_progress") {
                meta.activeGameId = null
                return null
            }
            if (isRecentForeignGame(game)) return null
            if (game.moves.length === 0) {
                games.delete(game.id)
                meta.gameIds = meta.gameIds.filter(id => id !== game.id)
                meta.activeGameId = null
                await removeItem(`${GAME_KEY_PREFIX}${game.id}`)
                await persistMetaAndProfile()
                return null
            }

            const timestamp = now()
            game.status = "abandoned"
            game.termination = typeof reason === "string" && reason ? reason : "restart"
            game.endedAt = timestamp
            game.updatedAt = timestamp
            patchAbandonedOutcomes(game)
            profile.lifetime.abandoned += 1
            meta.activeGameId = null
            await persistGame(game)
            await pruneDetailedHistory()
            return deepClone(game)
        }

        function updateHumanTendencies(profileLifetime, game, event, actionId, replacedCode) {
            const code = (actionId % 3) + 1
            const name = PIECE_NAMES[code]
            const cell = Math.floor(actionId / 3)
            profileLifetime.moves += 1
            profileLifetime.pieces[name] += 1
            profileLifetime.cellsByPiece[name][cell] += 1
            if (replacedCode === 0) profileLifetime.emptyPlacements += 1
            else profileLifetime.replacements += 1

            const priorHumanMove = game.moves.some(move => move.actor === "human")
            if (!priorHumanMove) profileLifetime.openings[actionId] += 1
        }

        function createHumanExample(game, move, legalMask, history) {
            return {
                schemaVersion: DATA_SCHEMA_VERSION,
                featureVersion: FEATURE_SCHEMA_VERSION,
                id: move.decisionId,
                gameId: game.id,
                ply: move.ply,
                capturedAt: move.playedAt,
                inputs: {
                    boardBefore: move.boardBefore,
                    legalMask,
                    legalActionCount: countMaskBits(legalMask),
                    starter: game.settings.starter,
                    botSkill: move.botSkill,
                    historyLength: history.length,
                    historyTail: history.slice(-HISTORY_LENGTH)
                },
                target: {chosenAction: move.actionId},
                audit: {
                    boardAfter: move.boardAfter,
                    wasReplacement: move.replacedPiece !== 0
                },
                rockfish: {
                    status: "pending",
                    engineVersion: null,
                    depthRequested: null,
                    depthCompleted: null,
                    scores: null,
                    bestScore: null,
                    chosenScore: null,
                    chosenRank: null,
                    regret: null
                },
                outcome: {
                    status: "pending",
                    valueForHuman: null,
                    pliesToEnd: null
                },
                training: {
                    policyEligible: true,
                    outcomeEligible: false,
                    exclusions: []
                }
            }
        }

        async function recordMoveInternal(event) {
            if (!event || event.mode !== "singleplayer" ||
                !["human", "rockfish"].includes(event.actor) ||
                !["X", "O"].includes(event.turn) ||
                !["X", "O"].includes(event.starter) ||
                !["X", "O"].includes(event.humanTurn)) {
                return null
            }

            let boardState
            let actionId
            try {
                boardState = encodeBoard(event.boardBefore)
                actionId = encodeAction(event.cell, event.piece)
            } catch (_error) {
                return null
            }
            if (winningLine(boardState) || !isLegalAction(boardState, actionId)) return null

            event.botSkill = clampSkill(event.botSkill)
            const boardAfter = applyAction(boardState, actionId)
            const replacedCode = codeAt(boardState, event.cell)
            let game = meta.activeGameId ? games.get(meta.activeGameId) : null
            if (game && isRecentForeignGame(game)) return null
            if (game && (game.status !== "in_progress" || game.lastBoard !== boardState)) {
                await abandonActiveGame("board_mismatch")
                game = null
            }
            if (!game) game = createGame(event, boardState, now())

            const timestamp = now()
            const ply = finiteNonNegative(game.totalPlies, game.moves.length)
            if (ply >= MAX_GAME_PLIES) {
                game.recording.stopped = true
                if (!game.recording.exclusions.includes("recording_limit")) {
                    game.recording.exclusions.push("recording_limit")
                }
                game.lastBoard = boardAfter
                game.totalPlies = ply + 1
                game.updatedAt = timestamp
                await persistGame(game)
                return {gameId: game.id, sampleId: null, boardKey: boardState}
            }

            const decisionId = event.actor === "human" ? `${game.id}:${ply}` : null
            const move = {
                ply,
                turn: event.turn,
                actor: event.actor,
                source: typeof event.source === "string" ? event.source : "unknown",
                actionId,
                boardBefore: boardState,
                boardAfter,
                replacedPiece: replacedCode,
                botSkill: event.botSkill,
                playedAt: timestamp,
                decisionId
            }
            const history = game.moves.map(previousMove => previousMove.actionId)
            if (event.actor === "human") {
                const mask = legalActionMask(boardState)
                game.examples.push(createHumanExample(game, move, mask, history))
                updateHumanTendencies(profile.lifetime, game, event, actionId, replacedCode)
            }
            game.moves.push(move)
            game.lastBoard = boardAfter
            game.totalPlies = ply + 1
            game.updatedAt = timestamp
            await persistGame(game)
            return {gameId: game.id, sampleId: decisionId, boardKey: boardState}
        }

        function snapshotResult(value) {
            if (!value || typeof value !== "object") return null
            return {
                winner: value.winner,
                winningPiece: value.winningPiece,
                winningLine: Array.isArray(value.winningLine) ? [...value.winningLine] : null
            }
        }

        async function finishGameInternal(result) {
            const game = meta.activeGameId ? games.get(meta.activeGameId) : null
            if (!game || game.status !== "in_progress" || game.moves.length === 0 ||
                isRecentForeignGame(game) || !result || !["X", "O"].includes(result.winner)) {
                return null
            }
            const finalLine = winningLine(game.lastBoard)
            if (!finalLine) return null

            const timestamp = now()
            const outcomeForHuman = result.winner === game.settings.humanTurn ? 1 : -1
            game.status = "completed"
            game.termination = "win"
            game.endedAt = timestamp
            game.updatedAt = timestamp
            game.result = {
                winner: result.winner,
                winnerRole: outcomeForHuman === 1 ? "human" : "rockfish",
                winningPiece: pieceCode(result.winningPiece) || codeAt(
                    game.lastBoard, finalLine[0]
                ),
                winningLine: finalLine,
                outcomeForHuman
            }
            game.examples.forEach(example => {
                example.outcome = {
                    status: "completed",
                    valueForHuman: outcomeForHuman,
                    pliesToEnd: finiteNonNegative(game.totalPlies, game.moves.length) -
                        1 - example.ply
                }
                example.training.outcomeEligible = true
            })

            profile.lifetime.gamesCompleted += 1
            if (outcomeForHuman === 1) profile.lifetime.wins += 1
            else profile.lifetime.losses += 1
            if (game.moves.at(-1)?.actor === "human") profile.lifetime.winningMoves += 1
            meta.activeGameId = null
            await persistGame(game)
            await pruneDetailedHistory()
            return deepClone(game)
        }

        function detailedDecisionCount() {
            let count = 0
            for (const game of games.values()) count += game.examples.length
            return count
        }

        async function pruneDetailedHistory() {
            const removedIds = []
            while (games.size > MAX_GAMES || detailedDecisionCount() > MAX_DECISIONS) {
                const candidates = [...games.values()]
                    .filter(game => game.id !== meta.activeGameId)
                    .sort((first, second) => {
                        const firstPriority = first.status === "abandoned" ? 0 : 1
                        const secondPriority = second.status === "abandoned" ? 0 : 1
                        return firstPriority - secondPriority ||
                            (first.endedAt || first.updatedAt) - (second.endedAt || second.updatedAt)
                    })
                if (candidates.length === 0) break
                const removed = candidates[0]
                games.delete(removed.id)
                meta.gameIds = meta.gameIds.filter(id => id !== removed.id)
                removedIds.push(removed.id)
            }
            if (removedIds.length > 0) {
                await persistMetaAndProfile(
                    removedIds.map(gameId => `${GAME_KEY_PREFIX}${gameId}`)
                )
            }
        }

        function favoriteKeys(counts) {
            const entries = Object.entries(counts)
            const maximum = Math.max(0, ...entries.map(([, count]) => count))
            return maximum === 0
                ? []
                : entries.filter(([, count]) => count === maximum).map(([key]) => key)
        }

        function summaryInternal() {
            const lifetime = profile.lifetime
            const cellCounts = Array.from({length: 9}, (_, cell) => (
                lifetime.cellsByPiece.rock[cell] + lifetime.cellsByPiece.paper[cell] +
                lifetime.cellsByPiece.scissors[cell]
            ))
            const maximumCellCount = Math.max(0, ...cellCounts)
            const maximumOpeningCount = Math.max(0, ...lifetime.openings)
            let datasetDecisions = 0
            let analyzedDecisions = 0
            for (const game of games.values()) {
                datasetDecisions += game.examples.length
                analyzedDecisions += game.examples.filter(example => (
                    example.rockfish?.status === "complete"
                )).length
            }

            return {
                moves: lifetime.moves,
                pieces: deepClone(lifetime.pieces),
                favoritePieces: favoriteKeys(lifetime.pieces),
                favoriteCells: maximumCellCount === 0
                    ? []
                    : cellCounts.flatMap((count, cell) => count === maximumCellCount ? [cell] : []),
                favoriteOpenings: maximumOpeningCount === 0
                    ? []
                    : lifetime.openings.flatMap((count, actionId) => {
                        if (count !== maximumOpeningCount) return []
                        const [cell, piece] = decodeAction(actionId)
                        return [{cell, piece: PIECE_NAMES[pieceCode(piece)]}]
                    }),
                replacements: lifetime.replacements,
                emptyPlacements: lifetime.emptyPlacements,
                replacementRate: lifetime.replacements + lifetime.emptyPlacements > 0
                    ? lifetime.replacements /
                        (lifetime.replacements + lifetime.emptyPlacements)
                    : null,
                gamesStarted: lifetime.gamesStarted,
                gamesCompleted: lifetime.gamesCompleted,
                wins: lifetime.wins,
                losses: lifetime.losses,
                abandoned: lifetime.abandoned,
                datasetGames: games.size,
                datasetDecisions,
                analyzedDecisions,
                storageMode
            }
        }

        function snapshotAnalysisIdentity(value) {
            if (!value || typeof value !== "object") return null
            return {
                gameId: value.gameId,
                sampleId: value.sampleId,
                boardKey: value.boardKey
            }
        }

        function analysisScores(example, analysis) {
            const scores = Array(27).fill(null)
            if (Array.isArray(analysis?.scores) && analysis.scores.length === 27) {
                analysis.scores.forEach((score, actionId) => {
                    if (((example.inputs.legalMask >>> actionId) & 1) === 1 &&
                        typeof score === "number" && Number.isFinite(score)) {
                        scores[actionId] = score
                    }
                })
            } else if (Array.isArray(analysis?.analysis)) {
                analysis.analysis.forEach(candidate => {
                    if (!Array.isArray(candidate?.move) ||
                        typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
                        return
                    }
                    try {
                        const actionId = encodeAction(candidate.move[0], candidate.move[1])
                        if (((example.inputs.legalMask >>> actionId) & 1) === 1) {
                            scores[actionId] = candidate.score
                        }
                    } catch (_error) {
                        // Malformed candidates are omitted from the teacher label.
                    }
                })
            }
            return scores.some(score => score !== null) ? scores : null
        }

        async function attachAnalysisInternal(identity, analysis) {
            if (!identity || typeof identity.gameId !== "string" ||
                typeof identity.sampleId !== "string" || !analysis ||
                typeof analysis !== "object") return false
            const game = games.get(identity.gameId)
            const example = game?.examples.find(item => item.id === identity.sampleId)
            if (!game || !example || identity.boardKey !== example.inputs.boardBefore) return false
            const scores = analysisScores(example, analysis)
            if (!scores) return false

            const legalScores = scores.filter(score => score !== null)
            const chosenScore = scores[example.target.chosenAction]
            const sortedUnique = [...new Set(legalScores)].sort((a, b) => b - a)
            const bestScore = sortedUnique[0]
            example.rockfish = {
                status: "complete",
                engineVersion: typeof analysis.engineVersion === "string"
                    ? analysis.engineVersion
                    : ENGINE_VERSION,
                depthRequested: finiteNonNegative(analysis.targetDepth, null),
                depthCompleted: finiteNonNegative(analysis.depth, null),
                scores,
                bestScore,
                chosenScore: typeof chosenScore === "number" ? chosenScore : null,
                chosenRank: typeof chosenScore === "number"
                    ? sortedUnique.indexOf(chosenScore) + 1
                    : null,
                regret: typeof chosenScore === "number" ? bestScore - chosenScore : null
            }
            game.updatedAt = now()
            await persistGame(game)
            return true
        }

        async function exportInternal() {
            const exportedGames = [...games.values()]
                .sort((first, second) => first.startedAt - second.startedAt)
                .map(game => deepClone(game))
            return {
                schemaVersion: DATA_SCHEMA_VERSION,
                featureVersion: FEATURE_SCHEMA_VERSION,
                exportedAt: now(),
                profile: deepClone(profile),
                games: exportedGames,
                decisions: exportedGames.flatMap(game => game.examples.map(example => deepClone(example)))
            }
        }

        async function resetLearningInternal() {
            const storedKeys = await listStorageKeys()
            const gameKeys = storedKeys
                ? storedKeys.filter(key => typeof key === "string" &&
                    key.startsWith(GAME_KEY_PREFIX))
                : [...games.keys()].map(id => `${GAME_KEY_PREFIX}${id}`)
            const previousRevision = finiteNonNegative(meta.revision)
            games.clear()
            meta = defaultMeta(now())
            meta.revision = previousRevision
            await persistMetaAndProfile(gameKeys)
            return summaryInternal()
        }

        const store = {
            ready: ensureReady,
            recordMove(value) {
                const event = snapshotMovePayload(value)
                return enqueue(() => recordMoveInternal(event))
            },
            finishGame(value) {
                const result = snapshotResult(value)
                return enqueue(() => finishGameInternal(result))
            },
            abandonGame(reason) {
                const safeReason = typeof reason === "string" ? reason : "restart"
                return enqueue(() => abandonActiveGame(safeReason))
            },
            attachAnalysis(identityValue, analysisValue) {
                const identity = snapshotAnalysisIdentity(identityValue)
                let analysis = null
                try {
                    analysis = deepClone(analysisValue)
                } catch (_error) {
                    return enqueue(() => false)
                }
                return enqueue(() => attachAnalysisInternal(identity, analysis))
            },
            getSummary() {
                return enqueue(() => deepClone(summaryInternal()))
            },
            exportData() {
                return enqueue(exportInternal)
            },
            resetLearning() {
                return enqueue(resetLearningInternal)
            }
        }
        return store
    }

    const api = {
        DATA_SCHEMA_VERSION,
        FEATURE_SCHEMA_VERSION,
        createMemoryStorage,
        createStore,
        decodeAction,
        decodeBoard,
        encodeAction,
        encodeBoard,
        isLegalAction,
        legalActionMask
    }

    if (typeof module !== "undefined" && module.exports) module.exports = api

    const isWindowScope = typeof window !== "undefined" && globalScope === window
    if (isWindowScope) {
        let browserStorage = null
        let browserSessionId = null
        const localStorageApi = globalScope.localforage
        if (localStorageApi && typeof localStorageApi.createInstance === "function") {
            try {
                browserStorage = localStorageApi.createInstance({
                    name: "rpsxo-data",
                    storeName: "player_data"
                })
            } catch (_error) {
                browserStorage = null
            }
        } else if (localStorageApi && typeof localStorageApi.getItem === "function") {
            browserStorage = localStorageApi
        }
        try {
            browserSessionId = globalScope.sessionStorage?.getItem("rpsxo-session-id")
            if (!browserSessionId) {
                browserSessionId = globalScope.crypto?.randomUUID?.() ||
                    `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
                globalScope.sessionStorage?.setItem("rpsxo-session-id", browserSessionId)
            }
        } catch (_error) {
            browserSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
        }
        globalScope.RpsxoPlayerData = createStore({
            storage: browserStorage,
            legacyStorage: localStorageApi,
            sessionId: browserSessionId
        })
    }
})(typeof globalThis !== "undefined" ? globalThis : null)
