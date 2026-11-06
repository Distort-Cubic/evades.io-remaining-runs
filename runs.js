void (async () => {
    const API = "/api/runs";

    // ============================================================
    // CONFIG
    // ============================================================

    // Maximum number of combinations being processed concurrently.
    const CONCURRENCY = 10;

    // Check crystal / amulet / both after the no-flag pass.
    const CHECK_FLAGGED = false;

    // true  = simple output:
    //         Mortuus / Sparkling-Shrine-Hard / interactions=0
    //
    // false = verbose output with flag information.
    const SIMPLE_OUTPUT = true;

    // true  = skip Assorted-Alcove and Assorted-Alcove-Hard
    // false = include them
    const HIDE_REMOVED_AREAS = true;

    // ============================================================
    // REMOVED AREAS
    // ============================================================

    const REMOVED_AREAS = new Set([
        "Assorted-Alcove",
        "Assorted-Alcove-Hard"
    ]);

    // ============================================================
    // READ HEROES / REGIONS FROM THE PAGE
    // ============================================================

    const regionSelect = document.querySelector("#region-filter");
    const heroSelect = document.querySelector("#hero-filter");

    if (!regionSelect || !heroSelect) {
        console.error(
            "Could not find #region-filter or #hero-filter."
        );
        return;
    }

    let regions = [...regionSelect.options]
        .filter(option => option.value !== "null")
        .map(option => ({
            value: option.value,
            name: option.textContent.trim()
        }));

    const heroes = [...heroSelect.options]
        .filter(option => option.value !== "null")
        .map(option => ({
            value: option.value,
            name: option.textContent.trim()
        }));

    // Optionally remove deleted areas.
    if (HIDE_REMOVED_AREAS) {
        regions = regions.filter(
            region => !REMOVED_AREAS.has(region.value)
        );
    }

    console.log(
        `Heroes: ${heroes.length} | Regions: ${regions.length}`
    );

    if (HIDE_REMOVED_AREAS) {
        console.log(
            "Skipping removed areas:",
            [...REMOVED_AREAS]
        );
    }

    // ============================================================
    // API QUERY
    // ============================================================

    async function query(
        region,
        hero,
        flags = null,
        interactions = null
    ) {
        const params = new URLSearchParams();

        params.set("region", region);
        params.set("hero", hero);

        if (flags !== null) {
            params.set("flags", flags);
        }

        if (interactions !== null) {
            params.set("interactions", interactions);
        }

        const url = `${API}?${params}`;

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(
                    `${response.status} ${response.statusText}`
                );
            }

            const runs = await response.json();

            let solos = 0;
            let duos = 0;
            let other = 0;

            for (const run of runs) {
                const interactionCount =
                    Array.isArray(run.interactions)
                        ? run.interactions.length
                        : 0;

                if (interactionCount === 0) {
                    solos++;
                } else if (interactionCount === 1) {
                    duos++;
                } else {
                    other++;
                }
            }

            return {
                region,
                hero,
                flags,
                interactions,

                total: runs.length,

                solos:
                    String(solos) +
                    (solos === 50 ? "+" : ""),

                duos:
                    String(duos) +
                    (duos === 50 ? "+" : ""),

                other:
                    String(other) +
                    (other === 50 ? "+" : ""),

                runs
            };

        } catch (error) {
            return {
                region,
                hero,
                flags,
                interactions,

                total: -1,

                solos: "ERROR",
                duos: "ERROR",
                other: "ERROR",

                error: String(error)
            };
        }
    }

    // ============================================================
    // DETERMINE WHETHER A RESULT IS EMPTY
    // ============================================================

    function isEmpty(result) {
        return (
            result.total === 0 &&
            result.solos === "0" &&
            result.duos === "0" &&
            result.other === "0"
        );
    }

    // ============================================================
    // FORMAT OUTPUT
    // ============================================================

    function describe(result) {
        // SIMPLE OUTPUT
        //
        // Examples:
        //
        // Mortuus / Sparkling-Shrine-Hard / interactions=0
        // Cybot / Dusty-Depths / any interactions
        //

        if (SIMPLE_OUTPUT) {
            const interactionText =
                result.interactions === null
                    ? "any interactions"
                    : `interactions=${result.interactions}`;

            return (
                `${result.hero} / ` +
                `${result.region} / ` +
                `${interactionText}`
            );
        }

        // VERBOSE OUTPUT
        const flagText =
            result.flags === null
                ? "no flags"
                : result.flags;

        const interactionText =
            result.interactions === null
                ? "any interactions"
                : `interactions=${result.interactions}`;

        return (
            `${result.hero} / ` +
            `${result.region} / ` +
            `${flagText} / ` +
            `${interactionText}`
        );
    }

    // ============================================================
    // RESULTS
    // ============================================================

    const allResults = [];

    function printResult(result) {
        allResults.push(result);

        if (result.total === -1) {
            console.error(
                `[ERROR] ${describe(result)}`,
                result.error
            );
            return;
        }

        // Only print empty combinations.
        if (isEmpty(result)) {
            console.log(
                `%c${describe(result)}`,
                "color:red;font-weight:bold"
            );
        }
    }

    // ============================================================
    // CONCURRENT COMBINATION WORKERS
    // ============================================================

    const combinations = [];

    // HERO FIRST, THEN REGION.
    //
    // Example:
    //
    // Magmax / Region 1
    // Magmax / Region 2
    // Magmax / Region 3
    // Rime   / Region 1
    // Rime   / Region 2
    // ...

    for (const hero of heroes) {
        for (const region of regions) {
            combinations.push({
                hero,
                region
            });
        }
    }

    // ============================================================
    // COMPLETED COMBINATIONS
    //
    // The fetch workers can finish in ANY order.
    // The ordered worker only looks for nextToPrint.
    // ============================================================

    const completed = new Map();
    const waiters = new Map();

    let nextToPrint = 0;

    function deliver(position, result) {
        completed.set(position, result);

        const waiter = waiters.get(position);

        if (waiter) {
            waiters.delete(position);
            waiter();
        }
    }

    function waitFor(position) {
        if (completed.has(position)) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            waiters.set(position, resolve);
        });
    }

    // ============================================================
    // REQUEST WORKER POOL
    // ============================================================

    const queue = [];

    let activeWorkers = 0;
    let nextToStart = 0;

    function startMore() {
        while (
            activeWorkers < CONCURRENCY &&
            nextToStart < combinations.length
        ) {
            const position = nextToStart++;
            startCombination(position);
        }
    }

    function startCombination(position) {
        const combination = combinations[position];

        activeWorkers++;

        (async () => {
            try {
                // =================================================
                // 1. CHECK "ANY"
                // =================================================

                const base = await query(
                    combination.region.value,
                    combination.hero.value,
                    null,
                    null
                );

                // =================================================
                // IF ANY IS EMPTY:
                //
                // This combination is DONE.
                //
                // NO interaction=0
                // NO interaction=1
                //
                // The ordered worker can print it immediately.
                // =================================================

                if (base.total === 0) {
                    deliver(position, {
                        base,
                        zero: null,
                        one: null,
                        baseEmpty: true
                    });

                    return;
                }

                // =================================================
                // 2. ANY WAS NOT EMPTY
                //
                // Now check BOTH 0 and 1 concurrently.
                // =================================================

                const [zero, one] = await Promise.all([
                    query(
                        combination.region.value,
                        combination.hero.value,
                        null,
                        "0"
                    ),

                    query(
                        combination.region.value,
                        combination.hero.value,
                        null,
                        "1"
                    )
                ]);

                deliver(position, {
                    base,
                    zero,
                    one,
                    baseEmpty: false
                });

            } catch (error) {
                console.error(
                    "Combination worker failed:",
                    combination,
                    error
                );

                deliver(position, {
                    base: {
                        region: combination.region.value,
                        hero: combination.hero.value,
                        flags: null,
                        interactions: null,
                        total: -1,
                        solos: "ERROR",
                        duos: "ERROR",
                        other: "ERROR",
                        error: String(error)
                    },
                    zero: null,
                    one: null,
                    baseEmpty: false
                });

            } finally {
                activeWorkers--;
                startMore();
            }
        })();
    }

    // ============================================================
    // ORDERED OUTPUT WORKER
    //
    // It ONLY asks:
    //
    //     "Is nextToPrint ready?"
    //
    // It does not scan later combinations.
    // ============================================================

    async function orderedOutput() {

        while (nextToPrint < combinations.length) {

            // Wait specifically for this combination.
            await waitFor(nextToPrint);

            const result = completed.get(nextToPrint);

            completed.delete(nextToPrint);

            // =====================================================
            // ALWAYS CONSIDER "ANY" FIRST
            // =====================================================

            if (isEmpty(result.base)) {
                printResult(result.base);

                // Since ANY was empty:
                //
                // 0 was never requested.
                // 1 was never requested.
                //
                // Immediately move to next combination.
                nextToPrint++;

                continue;
            }

            // =====================================================
            // ANY WAS NOT EMPTY
            //
            // It is not printed.
            //
            // Now consider 0.
            // =====================================================

            if (isEmpty(result.zero)) {
                printResult(result.zero);
            }

            // =====================================================
            // Now consider 1.
            // =====================================================

            if (isEmpty(result.one)) {
                printResult(result.one);
            }

            // =====================================================
            // NEXT COMBINATION
            // =====================================================

            nextToPrint++;
        }
    }

    // ============================================================
    // RUN NO-FLAG PASS
    // ============================================================

    console.log(
        `%cStarting no-flag pass`,
        "color:#44aaff;font-weight:bold"
    );

    // Start the ordered consumer first.
    const outputPromise = orderedOutput();

    // Then start the concurrent workers.
    startMore();

    // Wait until ordered output has reached the end.
    await outputPromise;

    console.log(
        `%cFinished no-flag pass`,
        "color:#44aaff;font-weight:bold"
    );

    // ============================================================
    // FLAGGED PASSES
    //
    // These are optional and only run when CHECK_FLAGGED=true.
    // ============================================================

    if (CHECK_FLAGGED) {

        const flagSets = [
            "obtained_crystal",
            "obtained_amulet",
            "obtained_crystal,obtained_amulet"
        ];

        for (const flags of flagSets) {

            // Reset ordering state.
            completed.clear();
            waiters.clear();

            nextToPrint = 0;
            nextToStart = 0;
            activeWorkers = 0;

            // ----------------------------------------------------
            // Flagged worker launcher
            // ----------------------------------------------------

            function startFlaggedMore() {
                while (
                    activeWorkers < CONCURRENCY &&
                    nextToStart < combinations.length
                ) {
                    const position = nextToStart++;
                    startFlaggedCombination(
                        position,
                        flags
                    );
                }
            }

            function startFlaggedCombination(
                position,
                flagSet
            ) {
                const combination =
                    combinations[position];

                activeWorkers++;

                (async () => {
                    try {

                        // ANY
                        const base = await query(
                            combination.region.value,
                            combination.hero.value,
                            flagSet,
                            null
                        );

                        // Empty ANY means no 0/1 requests.
                        if (base.total === 0) {
                            deliver(position, {
                                base,
                                zero: null,
                                one: null,
                                baseEmpty: true
                            });

                            return;
                        }

                        // Non-empty ANY → check 0 and 1.
                        const [zero, one] =
                            await Promise.all([
                                query(
                                    combination.region.value,
                                    combination.hero.value,
                                    flagSet,
                                    "0"
                                ),

                                query(
                                    combination.region.value,
                                    combination.hero.value,
                                    flagSet,
                                    "1"
                                )
                            ]);

                        deliver(position, {
                            base,
                            zero,
                            one,
                            baseEmpty: false
                        });

                    } finally {
                        activeWorkers--;
                        startFlaggedMore();
                    }
                })();
            }

            console.log(
                `%cStarting flags=${flags}`,
                "color:#ffaa00;font-weight:bold"
            );

            const flaggedOutput =
                orderedOutput();

            startFlaggedMore();

            await flaggedOutput;

            console.log(
                `%cFinished flags=${flags}`,
                "color:#ffaa00;font-weight:bold"
            );
        }
    }

    // ============================================================
    // FINISHED
    // ============================================================

    window.evadesRarityResults = allResults;

    console.log(
        `%cDONE — ${allResults.length} empty combinations found`,
        "color:#55cc55;font-weight:bold"
    );

    try {
        await navigator.clipboard.writeText(
            JSON.stringify(allResults, null, 2)
        );

        console.log("Results copied to clipboard.");
    } catch {
        console.log(
            "Results available at window.evadesRarityResults"
        );
    }
})();
