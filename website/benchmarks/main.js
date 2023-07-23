import { round, parseHash, fetchModels, fetchFiles } from '../utils.js'
import { createLinkE } from '../components/link.js'
import { createTextE } from '../components/text.js'
import { createTableScoreCell } from '../components/table-score-cell.js'
import * as LMEvaluationHarness from '../benchmarks/lm-evaluation-harness.js'
import * as HumanEvalPlus from '../benchmarks/human-eval-plus.js'
import * as CoT from '../benchmarks/cot.js'
import * as MTBench from '../benchmarks/mt-bench.js'
import { createModelLinkE } from '../components/model-link.js'
import { getModelNumParams } from '../utils.js'

async function createSingleBenchmarkV(baseUrl, benchmarkName, parameters) {
    switch (benchmarkName) {
        case 'lm-evaluation-harness':
            return await LMEvaluationHarness.createV(baseUrl)
        case 'human-eval-plus':
            return await HumanEvalPlus.createV(baseUrl, parameters)
        case 'cot':
            return await CoT.createV(baseUrl, parameters)
        case 'mt-bench':
            return await MTBench.createV(baseUrl, parameters)
        default:
            throw new Error()
    }
}

function computeModelRanks(models, getScore, getTotalScore) {
    const modelNames = [...new Set(models.map(({ model_name: model }) => model))]
    const modelsByName = Object.fromEntries(models.map(model => [model.model_name, model]))

    const totalScores = {}
    for (const modelName of modelNames)
        totalScores[modelName] = getTotalScore(modelName, modelsByName[modelName].benchmarks)

    const initialOrderTotalScore = modelNames.filter(modelName => totalScores[modelName] !== null)
        .toSorted((model1Name, model2Name) => totalScores[model2Name] - totalScores[model1Name])
    const initialOrderBaseModels = modelNames.filter(modelName =>
        modelsByName[modelName].benchmarks.length === 1 && modelsByName[modelName].benchmarks[0] === 'lm-evaluation-harness')
        .toSorted((model1Name, model2Name) => getScore(model2Name, ['lm-evaluation-harness'], 'lm-evaluation-harness')
            - getScore(model1Name, ['lm-evaluation-harness'], 'lm-evaluation-harness'))
    const initialFixedModels = initialOrderTotalScore.concat(initialOrderBaseModels)
    const initialFixedScores = Object.fromEntries(initialFixedModels.map((modelName, index) => [modelName, initialFixedModels.length - index]))
    const remainingModels = modelNames.filter(modelName => !initialFixedModels.includes(modelName))
    const minimumRemainingScore = initialOrderBaseModels.length

    const modelPairs = []
    for (const [i, model1Name] of modelNames.entries()) {
        for (const [j, model2Name] of modelNames.entries()) {
            if (i === j)
                break
            modelPairs.push([model1Name, model2Name])
        }
    }

    const performanceDifferences = new Map()
    for (const modelPair of modelPairs) {
        const [model1Name, model2Name] = modelPair

        const commonBenchmarks = modelsByName[model1Name].benchmarks
            .filter(benchmark => modelsByName[model2Name].benchmarks.includes(benchmark))

        if (commonBenchmarks.length === 1 && commonBenchmarks[0] === 'lm-evaluation-harness') {
            const model1NumBenchmarks = modelsByName[model1Name].benchmarks.length
            const model2NumBenchmarks = modelsByName[model2Name].benchmarks.length
            if (model1NumBenchmarks === 1 && model2NumBenchmarks !== 1) {
                performanceDifferences.set(modelPair, -Infinity)
                continue
            } else if (model1NumBenchmarks !== 1 && model2NumBenchmarks === 1) {
                performanceDifferences.set(modelPair, Infinity)
                continue
            }
        }

        let performanceDifference = 0
        for (const benchmarkName of commonBenchmarks) {
            const model1Performance = getScore(model1Name, commonBenchmarks, benchmarkName)
            const model2Performance = getScore(model2Name, commonBenchmarks, benchmarkName)
            performanceDifference += (model1Performance - model2Performance) / commonBenchmarks.length
        }

        if (performanceDifference !== 0)
            performanceDifferences.set(modelPair, performanceDifference)
    }

    function lossf(rankings) {
        return modelPairs.map(modelPair => {
            const [model1Name, model2Name] = modelPair
            if (!performanceDifferences.has(modelPair))
                return 0
            const performanceDifference = performanceDifferences.get(modelPair)
            const rankDifference = rankings.get(model1Name) - rankings.get(model2Name)
            if (rankDifference > 0 && performanceDifference === -Infinity)
                return 1e6 * rankDifference
            if (rankDifference < 0 && performanceDifference === Infinity)
                return 1e6 * (-rankDifference)
            return (rankDifference > 0 && performanceDifference < 0 || rankDifference < 0 && performanceDifference > 0) ? 1 : 0
        }).reduce((a, b) => a + b, 0)
    }

    function renormalize(rankings) {
        return new Map([...rankings.entries()]
            .toSorted(([model1Name, model1Rank], [model2Name, model2Rank]) => model2Rank - model1Rank)
            .map(([modelName, previousModelRank], index) => [modelName, modelNames.length - index]))
    }

    const initialPopulationSize = 100
    const minPopulationSize = 20
    let population = []
    for (let i = 0; i < initialPopulationSize; i++) {
        const rankings = renormalize(new Map(modelNames.map(modelName =>
            [modelName, initialFixedScores[modelName] ?? (Math.random()) * initialFixedModels.length])))
        const loss = lossf(rankings)
        population.push([rankings, loss])
    }

    const numIterations = 10_000
    for (let i = 0; i < numIterations; i++) {
        const currentItemIndex = Math.floor(Math.random() * population.length)
        const [currentRanking, currentLoss] = population[currentItemIndex]

        let newRanking = new Map(currentRanking)

        for (const modelName of remainingModels) {
            if (Math.random() < 1 / remainingModels.length)
                newRanking.set(modelName, 1 + minimumRemainingScore + (Math.random() * (modelNames.length - minimumRemainingScore)))
        }

        newRanking = renormalize(newRanking)

        const newLoss = lossf(newRanking)
        if (newLoss <= currentLoss)
            population.push([newRanking, newLoss])

        if (i % Math.round(initialPopulationSize / 5) === 0)
            population = population.toSorted(([ranking1, loss1], [ranking2, loss2]) => loss1 - loss2)
                .slice(0, Math.max(minPopulationSize, Math.ceil((1 - i / numIterations) * initialPopulationSize)))
    }

    const populationSortedByLoss = population.toSorted(([ranking1, loss1], [ranking2, loss2]) => loss1 - loss2)
    const lowestLoss = populationSortedByLoss[0][1]
    const populationItemsWithLowestLoss = populationSortedByLoss.filter(([ranking, loss]) => loss === lowestLoss)
        .map(([ranking, loss]) => [...ranking.entries()]
            .toSorted(([model1Name, model1Rank], [model2Name, model2Rank]) => model2Rank - model1Rank))

    let orderings = populationItemsWithLowestLoss
    for (let i = models.length - 1; i >= 0; i--)
        orderings = orderings.toSorted((ordering1, ordering2) => ordering1[i][0].localeCompare(ordering2[i][0]))

    return Object.fromEntries(orderings[0])
}

export async function createBenchmarksIndexV(baseUrl) {
    const containerE = document.createElement('div')

    const explanationE = document.createElement('div')
    explanationE.classList.add('main__explanation')
    const informationLinkE = document.createElement('a')
    informationLinkE.textContent = 'GitHub repository'
    informationLinkE.href = 'https://github.com/tju01/ilm-eval'
    explanationE.append(
        createTextE('See the '),
        informationLinkE,
        createTextE(' for more information.')
    )
    containerE.appendChild(explanationE)

    const models = await fetchModels(baseUrl)

    const [
        lmEvaluationHarnessResults,
        humanEvalPlusResults,
        cotResults,
        mtBenchResults,
    ] = await Promise.all([
        fetchFiles(baseUrl, models, 'lm-evaluation-harness'),
        fetchFiles(baseUrl, models, 'human-eval-plus', '/scores.json'),
        fetchFiles(baseUrl, models, 'cot', '/scores.json'),
        fetchFiles(baseUrl, models, 'mt-bench', '/scores.json'),
    ])

    const averageLmEvaluationHarnessScores =  Object.fromEntries(lmEvaluationHarnessResults.map(([modelName, results]) =>
        [modelName, LMEvaluationHarness.computeAverageScore(results.results)]))

    const cotResultsMap = CoT.computeRelativeScores(Object.fromEntries(cotResults))

    const mtBenchResultsMap = Object.fromEntries(mtBenchResults)

    const humanEvalPlusResultsMap = Object.fromEntries(humanEvalPlusResults)

    function getScore(model, benchmarks, benchmarkName) {
        if (!benchmarks.includes(benchmarkName))
            return null

        if (benchmarkName === 'lm-evaluation-harness')
            return averageLmEvaluationHarnessScores[model]
        else if (benchmarkName === 'human-eval-plus')
            return humanEvalPlusResultsMap[model].scores.plus
        else if (benchmarkName === 'cot')
            return cotResultsMap[model].total
        else if (benchmarkName === 'mt-bench')
            return mtBenchResultsMap[model].average

        return null
    }

    const allBenchmarks = ['mt-bench', 'cot', 'human-eval-plus', 'lm-evaluation-harness']

    const benchmarkMinimums = new Map()
    const benchmarkMaximums = new Map()
    for (const benchmarkName of allBenchmarks) {
        for (const { model_name: model, benchmarks } of models) {
            const score = getScore(model, benchmarks, benchmarkName)
            if (score === null)
                continue

            if (!benchmarkMinimums.has(benchmarkName))
                benchmarkMinimums.set(benchmarkName, score)
            if (!benchmarkMaximums.has(benchmarkName))
                benchmarkMaximums.set(benchmarkName, score)
            if (benchmarkMinimums.get(benchmarkName) > score)
                benchmarkMinimums.set(benchmarkName, score)
            if (benchmarkMaximums.get(benchmarkName) < score)
                benchmarkMaximums.set(benchmarkName, score)
        }
    }

    function getRelativeScore(model, benchmarks, benchmarkName) {
        const score = getScore(model, benchmarks, benchmarkName)
        return (score - benchmarkMinimums.get(benchmarkName))
            / (benchmarkMaximums.get(benchmarkName) - benchmarkMinimums.get(benchmarkName))
    }

    function getTotalScore(model, benchmarks) {
        if (!benchmarks.includes('lm-evaluation-harness'))
            return null
        if (!benchmarks.includes('human-eval-plus'))
            return null
        if (!benchmarks.includes('cot'))
            return null

        let relativeAverageScore = 0
        for (const benchmarkName of allBenchmarks)
            relativeAverageScore += getRelativeScore(model, benchmarks, benchmarkName) / allBenchmarks.length
        return relativeAverageScore * 10
    }

    const modelRanks = computeModelRanks(models, getRelativeScore, getTotalScore)
    const modelsSortedByRank = models.toSorted((model1, model2) => {
        const model1Rank = modelRanks[model1.model_name]
        const model2Rank = modelRanks[model2.model_name]
        return model2Rank - model1Rank
    })

    const allNumParameters = []
    for (const modelInformation of modelsSortedByRank) {
        const numParameters = getModelNumParams(modelInformation)
        if (numParameters === '' || numParameters === 'proprietary')
            continue
        allNumParameters.push(parseInt(numParameters.replace('B', '')))
    }

    const minNumParametersLog = Math.log2(Math.min(...allNumParameters))
    const maxNumParametersLog = Math.log2(Math.max(...allNumParameters))

    let allTotalScores = []
    for (const modelInformation of modelsSortedByRank) {
        const { model_name: model, benchmarks } = modelInformation
        const totalScore = getTotalScore(model, benchmarks)
        if (totalScore !== null)
            allTotalScores.push(totalScore)
    }

    const minTotalScore = Math.min(...allTotalScores)
    const maxTotalScore = Math.max(...allTotalScores)

    const tableE = document.createElement('table')
    tableE.classList.add('main__table')
    containerE.appendChild(tableE)

    const theadE = tableE.createTHead().insertRow()
    theadE.insertCell().appendChild(createTextE('Rank'))
    theadE.insertCell().appendChild(createTextE('Size'))
    theadE.insertCell().appendChild(createTextE('Model'))
    theadE.insertCell().appendChild(createTextE('Total'))
    theadE.insertCell()
    theadE.insertCell().appendChild(createLinkE('MT-Bench', { benchmark: 'mt-bench' }))
    theadE.insertCell().appendChild(createLinkE('CoT', { benchmark: 'cot' }))
    theadE.insertCell().appendChild(createLinkE('HumanEval+', { benchmark: 'human-eval-plus' }))
    theadE.insertCell().appendChild(createLinkE('LM-Eval', { benchmark: 'lm-evaluation-harness' }))
    const tbodyE = tableE.createTBody()

    let didInsertSeparatorToBaseModels = false
    for (const [position, modelInformation] of modelsSortedByRank.entries()) {
        const { model_name: model, benchmarks } = modelInformation

        let rowE = tbodyE.insertRow()

        if (benchmarks.length === 1 && benchmarks[0] === 'lm-evaluation-harness') {
            if (!didInsertSeparatorToBaseModels) {
                const separatorRowE = rowE.insertCell()
                separatorRowE.setAttribute('colspan', (5 + allBenchmarks.length).toString())
                separatorRowE.classList.add('separator-row')
                separatorRowE.textContent = 'Base models. Not evaluated on instruction-model specific benchmarks.'
                rowE = tbodyE.insertRow()
                didInsertSeparatorToBaseModels = true
            }

            createTableScoreCell(rowE, createTextE('(' + (position + 1) + ')'))
        } else {
            createTableScoreCell(rowE, createTextE(position + 1))
        }

        const numParameters = getModelNumParams(modelInformation)
        if (numParameters === '') {
            createTableScoreCell(rowE, createTextE(numParameters))
        } else if (numParameters === 'proprietary') {
            createTableScoreCell(rowE, createTextE(''), -1)
        } else {
            const color = 1 - ((Math.log2(parseInt(numParameters.replace('B', ''))) - minNumParametersLog)
                / (maxNumParametersLog - minNumParametersLog))
            createTableScoreCell(rowE, createTextE(numParameters), color)
        }

        rowE.insertCell().appendChild(createModelLinkE(modelInformation))

        const totalScore = getTotalScore(model, benchmarks)
        if (totalScore === null)
            createTableScoreCell(rowE, createTextE(''))
        else
            createTableScoreCell(rowE, createTextE(round(totalScore)), (totalScore - minTotalScore) / (maxTotalScore - minTotalScore))

        rowE.insertCell()

        for (const benchmarkName of allBenchmarks) {
            const score = getScore(model, benchmarks, benchmarkName)
            if (score === null) {
                createTableScoreCell(rowE, createTextE(''))
                continue
            }

            const relativeScore = getRelativeScore(model, benchmarks, benchmarkName)
            createTableScoreCell(rowE, createTextE(round(score)), relativeScore)
        }
    }

    const disclaimerE = createTextE('Disclaimer: '
        + 'Unless mentioned otherwise, do not compare scores to those on other leaderboards or those obtained using different evaluation code. '
        + 'The implementation can be different. Scores should only be compared between different models on this leaderboard. '
        + 'Also note that scores are often normalized and may therefore change as more models are added.')
    disclaimerE.classList.add('main__disclaimer')
    containerE.appendChild(disclaimerE)

    return containerE
}

export async function createBenchmarksV(baseUrl) {
    const hashParameters = parseHash()
    if (hashParameters.has('benchmark'))
        return createSingleBenchmarkV(baseUrl, hashParameters.get('benchmark'), hashParameters)
    return await createBenchmarksIndexV(baseUrl)
}
