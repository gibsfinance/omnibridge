import hre from 'hardhat'
import { expect, AssertionError } from 'chai'
import * as ethers from 'ethers'
import * as helpers from '../helpers/helpers'
import * as setup from '../setup'

/**
 * Hardening proof for the delivery router, run on an anvil node that forks a live chain.
 *
 * Start the node, then run this file against it. Nothing is broadcast to a live network.
 *
 *   anvil --fork-url https://rpc-ethereum.g4mm4.io --fork-block-number 22517700 --port 8545
 *   npx hardhat test test/omnibridge/router-hardening.fork.test.ts --network localhost
 *
 * Part 1 replays real "gas plus" strand transactions. For each one it drives the SAME real
 * mediator with the SAME real token, value and fee director data, once into the real OLD router
 * (the control: the callback must die with Panic 0x11) and once into a NEW router (the fix: the
 * end recipient must receive the full value). The only difference between the two runs is the router.
 *
 * Part 2 proves that recover() pays out a stranded delivery for every fee director shape.
 */

const ETHEREUM_RPCS = ['https://rpc-ethereum.g4mm4.io', 'https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com']
const BSC_RPCS = ['https://binance.llamarpc.com', 'https://bsc-dataseed.bnbchain.org']
// Block used by Part 2 and as the stand-in state for any case whose chain keeps no history.
const ETHEREUM_PART_TWO_BLOCK = 22_517_700

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const coder = ethers.AbiCoder.defaultAbiCoder()
// The new router keeps its delivery state in this slot: keccak256(abi.encode("omnibridgerouter.courier")).
// The value is the abi encoding of a string, not the raw bytes, so it is built the same way here.
const COURIER_SLOT = ethers.keccak256(coder.encode(['string'], ['omnibridgerouter.courier']))
// The OLD deployed router keeps the same state under the key it was deployed with. That key is fixed on chain.
const OLD_ROUTER_COURIER_SLOT = ethers.keccak256(coder.encode(['string'], ['omnibridgerouter.runner']))
// The entry records the identifier of the message it handles here: keccak256(abi.encode("omnibridgerouter.entryMessage")).
// A payout earns the tip only when its own message identifier equals this word. The constructor sets it to 1 (idle).
const ENTRY_MESSAGE_SLOT = ethers.keccak256(coder.encode(['string'], ['omnibridgerouter.entryMessage']))
// The Panic(uint256) selector followed by code 0x11, which is the checked arithmetic underflow code.
const PANIC_UNDERFLOW_OUTPUT = '0x4e487b71' + '11'.padStart(64, '0')
// The gas the message asks the mediator to run with. All six real strands used this limit.
const MESSAGE_GAS = 2_000_000n

const unwrapBit = 0b0010n
const fixedFeeBit = 0b0001n
const percentFeeBit = 0b1000n

const bridgeAbi = [
    'function safeExecuteSignaturesWithAutoGasLimit(bytes _data, bytes _signatures)',
    'function safeExecuteSignaturesWithAutoGasLimit(address courier, bytes _data, bytes _signatures)',
    'function relayedMessages(bytes32) view returns (bool)',
    'function messageCallStatus(bytes32) view returns (bool)',
]
const mediatorAbi = [
    'function handleBridgedTokensAndCall(address _token, address _recipient, uint256 _value, bytes _data)',
    'function handleNativeTokensAndCall(address _token, address _recipient, uint256 _value, bytes _data)',
    'function mediatorContractOnOtherSide() view returns (address)',
    'function bridgeContract() view returns (address)',
]
const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']
const routerInterface = new ethers.Interface([
    'function onTokenBridged(address _token, uint256 _value, bytes _data)',
    'function COURIER_SLOT() view returns (bytes32)',
])
const mediatorInterface = new ethers.Interface(mediatorAbi)
const bridgeInterface = new ethers.Interface(bridgeAbi)
const onTokenBridgedSelector = routerInterface.getFunction('onTokenBridged')!.selector

// ---------------------------------------------------------------------------------------------
// Small node helpers
// ---------------------------------------------------------------------------------------------

const rpc = (method: string, params: unknown[] = []) => hre.ethers.provider.send(method, params)

const word = (value: bigint) => ethers.zeroPadValue(ethers.toBeHex(value), 32)

/** Writes one storage word on the forked node. */
const writeStorage = (address: string, slot: string, value: bigint) =>
    rpc('anvil_setStorageAt', [address, slot, word(value)])

/** Runs a body, then rolls the node back so the next body starts from the same state. */
const isolated = async <T>(body: () => Promise<T>): Promise<T> => {
    const snapshotId = await rpc('evm_snapshot')
    try {
        return await body()
    } finally {
        await rpc('evm_revert', [snapshotId])
    }
}

/** Forks a chain at a block from the first endpoint that has the state. Returns the endpoint used. */
const forkAt = async (rpcs: string[], blockNumber: number, probeAddress: string): Promise<string | undefined> => {
    for (const jsonRpcUrl of rpcs) {
        try {
            await rpc('anvil_reset', [{ forking: { jsonRpcUrl, blockNumber } }])
            const code = await hre.ethers.provider.getCode(probeAddress)
            // A pinned base fee from an earlier run would stick to the node. Reset it so every case starts cheap.
            await rpc('anvil_setNextBlockBaseFeePerGas', [ethers.toBeHex(1_000n)])
            if (code !== '0x') return jsonRpcUrl
        } catch {
            // try the next endpoint
        }
    }
    return undefined
}

const upstream = async <T>(rpcs: string[], body: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T | undefined> => {
    for (const url of rpcs) {
        const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true })
        try {
            return await body(provider)
        } catch {
            // try the next endpoint
        } finally {
            provider.destroy()
        }
    }
    return undefined
}

type CallFrame = { to?: string; input?: string; error?: string; output?: string; calls?: CallFrame[] }
const flatten = (frame: CallFrame): CallFrame[] => [frame, ...(frame.calls ?? []).flatMap(flatten)]

// ---------------------------------------------------------------------------------------------
// The six real strands
// ---------------------------------------------------------------------------------------------

type RealCase = {
    id: number
    chain: 'ethereum' | 'bsc'
    label: string
    hash: string
    wNative: string
}

const REAL_CASES: RealCase[] = [
    { id: 2, chain: 'ethereum', label: 'eHEX', hash: '0x3686360ed52d22918aa50abaa716d18d021a2c113054dd3a48e84b2047747ccb', wNative: WETH },
    { id: 6, chain: 'ethereum', label: 'WETH', hash: '0xa3effa34667be656ffab810d2b2c394d4d32b231e2435a7501202bcdaea91718', wNative: WETH },
    { id: 9, chain: 'ethereum', label: 'WETH', hash: '0xdf0fa23313546de4feba39677e374cb007ec6433a70b2f02e753c5b40168612a', wNative: WETH },
    { id: 10, chain: 'ethereum', label: 'WETH', hash: '0x5edabbeaccd85925f7c15d0139706ae1bf88a088447b80e3c0b2eb3943d3bcc5', wNative: WETH },
    { id: 11, chain: 'ethereum', label: 'USDC', hash: '0x1256cf1161d50c29d1a5ed00cf8ad7e24a9231b54829cd223283b18a13cf7dfb', wNative: WETH },
    { id: 12, chain: 'bsc', label: '93Q', hash: '0x89cb83a5396b4238562a415254f1d37243848999b857418cea95aee8c492287f', wNative: WBNB },
]

type DecodedStrand = {
    blockNumber: number
    transactionTarget: string
    mediator: string
    oldRouter: string
    token: string
    value: bigint
    innerFunction: 'handleBridgedTokensAndCall' | 'handleNativeTokensAndCall'
    feeDirectorData: string
    feeDirector: { recipient: string; settings: bigint; limit: bigint; multiplier: bigint }
    messageGas: bigint
}

type DecodeResult = { decoded: DecodedStrand } | { reason: string }

/** Reads a real strand transaction and recovers the signed message and its inner call. */
const decodeStrand = async (realCase: RealCase): Promise<DecodeResult> => {
    const rpcs = realCase.chain === 'ethereum' ? ETHEREUM_RPCS : BSC_RPCS
    const transaction = await upstream(rpcs, (provider) => provider.getTransaction(realCase.hash))
    if (!transaction) return { reason: 'no endpoint returned the transaction' }
    let message: string
    const direct = bridgeInterface.getFunction('safeExecuteSignaturesWithAutoGasLimit(bytes,bytes)')!
    const viaCourier = bridgeInterface.getFunction('safeExecuteSignaturesWithAutoGasLimit(address,bytes,bytes)')!
    const selector = transaction.data.slice(0, 10)
    if (selector === direct.selector) {
        message = bridgeInterface.decodeFunctionData(direct, transaction.data)[0]
    } else if (selector === viaCourier.selector) {
        message = bridgeInterface.decodeFunctionData(viaCourier, transaction.data)[1]
    } else {
        return { reason: `unknown outer selector ${selector}` }
    }
    const bytes = ethers.getBytes(message)
    const mediator = ethers.getAddress(ethers.hexlify(bytes.slice(52, 72)))
    const messageGas = BigInt(ethers.hexlify(bytes.slice(72, 76)))
    const innerCall = ethers.hexlify(bytes.slice(79 + bytes[76] + bytes[77]))
    const innerSelector = innerCall.slice(0, 10)
    const innerFunction = (['handleBridgedTokensAndCall', 'handleNativeTokensAndCall'] as const).find(
        (name) => mediatorInterface.getFunction(name)!.selector === innerSelector,
    )
    if (!innerFunction) return { reason: `inner selector ${innerSelector} is not a handle...TokensAndCall` }
    let token: string, oldRouter: string, value: bigint, feeDirectorData: string
    try {
        ;[token, oldRouter, value, feeDirectorData] = mediatorInterface.decodeFunctionData(innerFunction, innerCall)
    } catch (error) {
        return { reason: `inner call does not decode: ${(error as Error).message.slice(0, 100)}` }
    }
    let feeDirector: DecodedStrand['feeDirector']
    try {
        const [recipient, settings, limit, multiplier] = coder.decode(
            ['address', 'uint256', 'uint256', 'uint256'],
            feeDirectorData,
        )
        feeDirector = { recipient, settings, limit, multiplier }
    } catch {
        return {
            reason:
                `the inner data (${ethers.getBytes(feeDirectorData).length} bytes) is not a four-word FeeDirector, ` +
                `and the real token is ${token}`,
        }
    }
    return {
        decoded: {
            blockNumber: transaction.blockNumber!,
            transactionTarget: transaction.to!,
            mediator,
            oldRouter,
            token,
            value,
            innerFunction,
            feeDirectorData,
            feeDirector,
            messageGas,
        },
    }
}

const isGasPlus = (settings: bigint) => (settings & fixedFeeBit) === 0n && (settings & percentFeeBit) === 0n

// ---------------------------------------------------------------------------------------------
// Driving the real mediator and measuring what happened
// ---------------------------------------------------------------------------------------------

type Outcome = {
    callbackFrames: number
    callbackReverted: boolean
    callbackOutput: string
    endRecipientGain: bigint
    endRecipientOtherAssetGain: bigint
    routerTokenGain: bigint
    routerNativeGain: bigint
    courierGain: bigint
    receiptBlockBaseFee: bigint
}

/** Asserts the callback died with the checked-arithmetic underflow and the tokens are stuck in the router. */
const assertStrandedByUnderflow = (outcome: Outcome, value: bigint) => {
    expect(outcome.callbackFrames, 'the mediator called the router callback once').to.equal(1)
    expect(outcome.callbackReverted, 'the router callback reverted').to.equal(true)
    expect(outcome.callbackOutput, 'the revert is Panic 0x11 (underflow), not any other failure').to.equal(
        PANIC_UNDERFLOW_OUTPUT,
    )
    expect(outcome.routerTokenGain, 'the tokens are stranded in the router').to.equal(value)
    expect(outcome.endRecipientGain, 'the end recipient got nothing').to.equal(0n)
}

/** Asserts the end recipient got exactly the value and the router kept nothing. */
const assertDeliveredInFull = (outcome: Outcome, value: bigint) => {
    expect(outcome.callbackFrames, 'the mediator called the router callback once').to.equal(1)
    expect(outcome.callbackReverted, 'the router callback did not revert').to.equal(false)
    expect(outcome.callbackOutput).to.not.equal(PANIC_UNDERFLOW_OUTPUT)
    expect(outcome.endRecipientGain, 'the end recipient got exactly the value').to.equal(value)
    expect(outcome.endRecipientOtherAssetGain, 'nothing arrived in the other asset form').to.equal(0n)
    expect(outcome.routerTokenGain, 'the router keeps no tokens').to.equal(0n)
    expect(outcome.routerNativeGain, 'the router keeps no native coin').to.equal(0n)
    expect(outcome.courierGain, 'no fee went to a courier').to.equal(0n)
}

describe('Router hardening against real strands, on an anvil fork', function () {
    this.timeout(900_000)

    const decodedByCase = new Map<number, DecodeResult>()

    before(async function () {
        const chainId = Number((await hre.ethers.provider.getNetwork()).chainId)
        console.log(`      connected node chain id ${chainId} (the test re-forks per case)`)
        for (const realCase of REAL_CASES) {
            decodedByCase.set(realCase.id, (await decodeStrand(realCase)) ?? { reason: 'decode failed' })
        }
    })

    // -----------------------------------------------------------------------------------------
    // Part 1
    // -----------------------------------------------------------------------------------------
    describe('Part 1: gas plus underflow prevention', () => {
        for (const realCase of REAL_CASES) {
            describe(`strand #${realCase.id} ${realCase.chain} ${realCase.label}`, () => {
                let decoded: DecodedStrand | undefined
                let skipReason: string | undefined
                let stateNote = ''
                let newRouter!: string
                let bridge!: string
                let signer!: Awaited<ReturnType<typeof hre.ethers.getSigners>>[number]
                let spoof!: ethers.Contract
                let tokenContract!: ethers.Contract
                let toNative = false
                let oldCourierSlotValue = 0n
                // The identifier the stand-in bridge reports while it delivers.
                const spoofMessageId = ethers.keccak256(ethers.toUtf8Bytes(`hardening-${realCase.id}`))

                /** Drives the real mediator into a router and measures every balance that matters. */
                const drive = async (routerAddress: string, options: { gasPrice?: bigint } = {}): Promise<Outcome> => {
                    const strand = decoded!
                    const courierAddress = ethers.getAddress('0x' + 'ab'.repeat(20))
                    const readAssets = async () => ({
                        recipientToken: (await tokenContract.balanceOf(strand.feeDirector.recipient)) as bigint,
                        recipientNative: await hre.ethers.provider.getBalance(strand.feeDirector.recipient),
                        routerToken: (await tokenContract.balanceOf(routerAddress)) as bigint,
                        routerNative: await hre.ethers.provider.getBalance(routerAddress),
                        courierToken: (await tokenContract.balanceOf(courierAddress)) as bigint,
                        courierNative: await hre.ethers.provider.getBalance(courierAddress),
                    })
                    const before = await readAssets()
                    // The forked chain's base fee decays towards zero on a quiet node. Pin a realistic one so the
                    // gas formula has a real price to multiply.
                    if (options.gasPrice) await rpc('anvil_setNextBlockBaseFeePerGas', [ethers.toBeHex(10_000_000_000n)])
                    const callData = mediatorInterface.encodeFunctionData(strand.innerFunction, [
                        strand.token,
                        routerAddress,
                        strand.value,
                        strand.feeDirectorData,
                    ])
                    const transaction = await spoof.relay(strand.mediator, callData, MESSAGE_GAS, {
                        gasLimit: 30_000_000n,
                        ...(options.gasPrice ? { gasPrice: options.gasPrice } : {}),
                    })
                    const receipt = await transaction.wait()
                    const trace = (await rpc('debug_traceTransaction', [
                        transaction.hash,
                        { tracer: 'callTracer' },
                    ])) as CallFrame
                    const callbacks = flatten(trace).filter(
                        (frame) =>
                            frame.to?.toLowerCase() === routerAddress.toLowerCase() &&
                            frame.input?.startsWith(onTokenBridgedSelector),
                    )
                    const after = await readAssets()
                    const block = await hre.ethers.provider.getBlock(receipt.blockNumber)
                    const recipientGainToken = after.recipientToken - before.recipientToken
                    const recipientGainNative = after.recipientNative - before.recipientNative
                    const courierGainToken = after.courierToken - before.courierToken
                    const courierGainNative = after.courierNative - before.courierNative
                    return {
                        callbackFrames: callbacks.length,
                        callbackReverted: callbacks.length > 0 && Boolean(callbacks[0].error),
                        callbackOutput: callbacks[0]?.output ?? '0x',
                        endRecipientGain: toNative ? recipientGainNative : recipientGainToken,
                        endRecipientOtherAssetGain: toNative ? recipientGainToken : recipientGainNative,
                        routerTokenGain: after.routerToken - before.routerToken,
                        routerNativeGain: after.routerNative - before.routerNative,
                        courierGain: toNative ? courierGainNative : courierGainToken,
                        receiptBlockBaseFee: block?.baseFeePerGas ?? 0n,
                    }
                }

                before(async function () {
                    const result = decodedByCase.get(realCase.id)!
                    if ('reason' in result) {
                        skipReason = result.reason
                        return
                    }
                    decoded = result.decoded
                    const rpcs = realCase.chain === 'ethereum' ? ETHEREUM_RPCS : BSC_RPCS
                    let usedRpc = await forkAt(rpcs, decoded.blockNumber - 1, decoded.oldRouter)
                    stateNote = `state at block ${decoded.blockNumber - 1} (one before the strand)`
                    if (!usedRpc) {
                        // The chain keeps no history at that depth. Fall back to the newest state, where
                        // the same real contracts and the same real data still exist. This is labelled.
                        const latest = await upstream(rpcs, (provider) => provider.getBlockNumber())
                        if (latest !== undefined) {
                            usedRpc = await forkAt(rpcs, latest - 20, decoded.oldRouter)
                            stateNote = `NEWEST state (block ${latest - 20}); no endpoint keeps block ${decoded.blockNumber - 1}`
                        }
                    }
                    if (!usedRpc) {
                        skipReason = 'no endpoint could fork this chain'
                        return
                    }
                    console.log(`      [#${realCase.id}] forked via ${usedRpc}, ${stateNote}`)

                    ;[signer] = await hre.ethers.getSigners()
                    const mediator = new ethers.Contract(decoded.mediator, mediatorAbi, hre.ethers.provider)
                    bridge = await mediator.bridgeContract()
                    const otherSide: string = await mediator.mediatorContractOnOtherSide()
                    // Replace the bridge code with the gas-limited caller. Every onlyMediator call still
                    // arrives from the bridge address, and the real mediator code runs untouched.
                    const callerArtifact = await hre.artifacts.readArtifact('GasLimitedCaller')
                    const callerFactory = await hre.ethers.getContractFactory('GasLimitedCaller')
                    await rpc('anvil_setCode', [bridge, callerArtifact.deployedBytecode])
                    spoof = new ethers.Contract(bridge, callerFactory.interface, signer)
                    await (await spoof.setMessageSender(otherSide)).wait()
                    await (await spoof.setMessageId(spoofMessageId)).wait()

                    tokenContract = new ethers.Contract(decoded.token, erc20Abi, hre.ethers.provider)
                    toNative =
                        ((decoded.feeDirector.settings & unwrapBit) === unwrapBit) &&
                        decoded.token.toLowerCase() === realCase.wNative.toLowerCase()

                    const routerFactory = await hre.ethers.getContractFactory('TokenOmnibridgeRouter')
                    const deployed = await routerFactory.deploy(decoded.mediator, realCase.wNative, await signer.getAddress())
                    await deployed.waitForDeployment()
                    newRouter = await deployed.getAddress()
                    // The slot constant must be the one the router really uses, or every state edit says nothing.
                    expect(await deployed.COURIER_SLOT()).to.equal(COURIER_SLOT)
                    // The entry message slot is private; its idle value 1 from the constructor proves the slot is right.
                    expect(BigInt(await hre.ethers.provider.getStorage(newRouter, ENTRY_MESSAGE_SLOT))).to.equal(1n)

                    oldCourierSlotValue = BigInt(await hre.ethers.provider.getStorage(decoded.oldRouter, OLD_ROUTER_COURIER_SLOT))
                })

                const guard = (context: Mocha.Context) => {
                    if (skipReason) {
                        console.log(`      [#${realCase.id}] CANNOT BE BUILT FROM REAL DATA: ${skipReason}`)
                        context.skip()
                    }
                }

                it('decodes the real transaction into a gas plus strand executed directly on the bridge', async function () {
                    guard(this)
                    const strand = decoded!
                    console.log(`      [#${realCase.id}] transaction target ${strand.transactionTarget}`)
                    console.log(`      [#${realCase.id}] mediator (message executor) ${strand.mediator}`)
                    console.log(`      [#${realCase.id}] old router (inner recipient) ${strand.oldRouter}`)
                    console.log(`      [#${realCase.id}] token ${strand.token}, value ${strand.value}, call ${strand.innerFunction}`)
                    console.log(
                        `      [#${realCase.id}] end recipient ${strand.feeDirector.recipient}, settings ${strand.feeDirector.settings}, ` +
                            `limit ${strand.feeDirector.limit}, multiplier ${strand.feeDirector.multiplier}, unwrap to native ${toNative}`,
                    )
                    console.log(`      [#${realCase.id}] old router courier slot leftover at this state: ${oldCourierSlotValue}`)
                    expect(strand.transactionTarget.toLowerCase(), 'the transaction went straight to the bridge').to.equal(
                        bridge.toLowerCase(),
                    )
                    expect(isGasPlus(strand.feeDirector.settings), 'settings select the gas plus fee path').to.equal(true)
                    expect(strand.messageGas).to.equal(MESSAGE_GAS)
                })

                it('CONTROL: the real OLD router dies with Panic 0x11 and strands the tokens', async function () {
                    guard(this)
                    const strand = decoded!
                    // The leftover value 1 is the post-delivery idle sentinel. The deployed router treats it as
                    // a named courier and underflows. Both states must show Panic 0x11.
                    for (const [name, courierState] of [
                        ['leftover as found', oldCourierSlotValue],
                        ['post-delivery sentinel 1', 1n],
                    ] as const) {
                        const outcome = await isolated(async () => {
                            await writeStorage(strand.oldRouter, OLD_ROUTER_COURIER_SLOT, courierState)
                            return drive(strand.oldRouter)
                        })
                        console.log(
                            `      [#${realCase.id}] OLD router, courier slot ${name}: callback reverted=${outcome.callbackReverted} ` +
                                `output=${outcome.callbackOutput.slice(0, 74)} stranded=${outcome.routerTokenGain} recipient gain=${outcome.endRecipientGain}`,
                        )
                        assertStrandedByUnderflow(outcome, strand.value)
                    }
                })

                it('CONTROL BASELINE: the real OLD router delivers when its courier slot is fresh 0, so only the sentinel breaks it', async function () {
                    guard(this)
                    const strand = decoded!
                    const outcome = await isolated(async () => {
                        await writeStorage(strand.oldRouter, OLD_ROUTER_COURIER_SLOT, 0n)
                        return drive(strand.oldRouter)
                    })
                    console.log(
                        `      [#${realCase.id}] OLD router, courier slot fresh 0: reverted=${outcome.callbackReverted} ` +
                            `recipient gain=${outcome.endRecipientGain} (value ${strand.value}) router kept=${outcome.routerTokenGain}`,
                    )
                    assertDeliveredInFull(outcome, strand.value)
                })

                for (const [name, courierState] of [
                    ['fresh 0', 0n],
                    ['post-delivery sentinel 1', 1n],
                ] as const) {
                    it(`FIX: the NEW router delivers the full value with COURIER_SLOT ${name}`, async function () {
                        guard(this)
                        const strand = decoded!
                        const outcome = await isolated(async () => {
                            await writeStorage(newRouter, COURIER_SLOT, courierState)
                            return drive(newRouter)
                        })
                        console.log(
                            `      [#${realCase.id}] NEW router, COURIER_SLOT ${name}: reverted=${outcome.callbackReverted} ` +
                                `end recipient gain=${outcome.endRecipientGain} (expected ${strand.value}) router kept token=${outcome.routerTokenGain} native=${outcome.routerNativeGain}`,
                        )
                        assertDeliveredInFull(outcome, strand.value)
                    })
                }

                it('GENUINE COURIER: the fee path is entered, does not underflow, and takes a sane fee', async function () {
                    guard(this)
                    const strand = decoded!
                    const courierAddress = ethers.getAddress('0x' + 'ab'.repeat(20))
                    // This is the value safeExecuteSignaturesWithAutoGasLimit writes: the gas left at entry in
                    // the low 96 bits and the courier in the high bits. The message gas is the most gas the
                    // callback can ever see, so gas used inside the callback is positive and below this number.
                    const entryGas = MESSAGE_GAS
                    const courierWord = entryGas | (BigInt(courierAddress) << 96n)
                    const gasPrice = 30_000_000_000n
                    // The entry also records the message it handles. Writing both words is what the entry does.
                    const outcome = await isolated(async () => {
                        await writeStorage(newRouter, COURIER_SLOT, courierWord)
                        await writeStorage(newRouter, ENTRY_MESSAGE_SLOT, BigInt(spoofMessageId))
                        return drive(newRouter, { gasPrice })
                    }).finally(() =>
                        // The pinned base fee sticks to the node. Put a tiny one back so later blocks stay cheap.
                        rpc('anvil_setNextBlockBaseFeePerGas', [ethers.toBeHex(1_000n)]),
                    )
                    // A courier word with no entry handling THIS message (the slot left idle) must earn nothing:
                    // the tip is bound to the message, so an ambient courier never leaks into another payout.
                    const unboundOutcome = await isolated(async () => {
                        await writeStorage(newRouter, COURIER_SLOT, courierWord)
                        return drive(newRouter, { gasPrice })
                    }).finally(() => rpc('anvil_setNextBlockBaseFeePerGas', [ethers.toBeHex(1_000n)]))
                    expect(unboundOutcome.courierGain, 'no tip without the entry handling this message').to.equal(0n)
                    expect(unboundOutcome.endRecipientGain, 'the recipient is paid in full instead').to.equal(strand.value)
                    const fee = outcome.courierGain
                    console.log(
                        `      [#${realCase.id}] genuine courier: reverted=${outcome.callbackReverted} fee to courier=${fee} ` +
                            `recipient gain=${outcome.endRecipientGain} limit=${strand.feeDirector.limit} block base fee=${outcome.receiptBlockBaseFee}`,
                    )
                    expect(outcome.callbackFrames).to.equal(1)
                    expect(outcome.callbackReverted, 'no revert on a genuine courier delivery').to.equal(false)
                    expect(outcome.callbackOutput).to.not.equal(PANIC_UNDERFLOW_OUTPUT)
                    expect(outcome.routerTokenGain, 'router retains nothing').to.equal(0n)
                    expect(outcome.routerNativeGain).to.equal(0n)
                    expect(fee <= strand.feeDirector.limit, 'the fee never exceeds the limit').to.equal(true)
                    expect(fee <= strand.value).to.equal(true)
                    expect(outcome.endRecipientGain + fee, 'recipient plus courier equals the value').to.equal(strand.value)
                    if (strand.feeDirector.limit > 0n && strand.feeDirector.multiplier > 0n && outcome.receiptBlockBaseFee > 0n) {
                        // With a limit above zero the fee comes from the gas formula and must be positive.
                        expect(fee > 0n, 'the gas formula produced a fee').to.equal(true)
                        // gasUsed is positive and below the entry gas, so the fee sits between the two bounds.
                        const upper =
                            ((entryGas + (toNative ? 50_000n : 100_000n)) * strand.feeDirector.multiplier * outcome.receiptBlockBaseFee) /
                            10n ** 18n
                        const lower = ((toNative ? 50_000n : 100_000n) * strand.feeDirector.multiplier * outcome.receiptBlockBaseFee) / 10n ** 18n
                        const expectedCeiling = upper > strand.feeDirector.limit ? strand.feeDirector.limit : upper
                        expect(fee <= expectedCeiling, `fee ${fee} within ceiling ${expectedCeiling}`).to.equal(true)
                        const expectedFloor = lower > strand.feeDirector.limit ? strand.feeDirector.limit : lower
                        expect(fee >= expectedFloor, `fee ${fee} above floor ${expectedFloor}`).to.equal(true)
                    } else {
                        console.log(`      [#${realCase.id}] limit is ${strand.feeDirector.limit}, so the formula result is capped to a zero fee`)
                        expect(fee).to.equal(0n)
                    }
                })

                it('CAN FAIL: each assertion rejects the wrong router and the wrong value', async function () {
                    guard(this)
                    const strand = decoded!
                    await isolated(async () => {
                        await writeStorage(strand.oldRouter, OLD_ROUTER_COURIER_SLOT, 1n)
                        await writeStorage(newRouter, COURIER_SLOT, 1n)
                        const oldOutcome = await drive(strand.oldRouter)
                        const newOutcome = await drive(newRouter)
                        // sanity: each is judged correctly by its own assertion
                        assertStrandedByUnderflow(oldOutcome, strand.value)
                        assertDeliveredInFull(newOutcome, strand.value)
                        // the underflow check must reject the NEW router, which does not underflow
                        expect(() => assertStrandedByUnderflow(newOutcome, strand.value)).to.throw(AssertionError)
                        // the delivery check must reject the OLD router, which strands
                        expect(() => assertDeliveredInFull(oldOutcome, strand.value)).to.throw(AssertionError)
                        // and the delivery check must reject a wrong expected value
                        expect(() => assertDeliveredInFull(newOutcome, strand.value + 1n)).to.throw(AssertionError)
                        console.log(`      [#${realCase.id}] negative controls: wrong router and wrong value are both rejected`)
                    })
                })
            })
        }
    })

    // -----------------------------------------------------------------------------------------
    // Part 2
    // -----------------------------------------------------------------------------------------
    // Anvil twin of the signature-port test in router-stranding.fork.test.ts. That file uses the
    // hardhat revert matchers, which cannot see a revert reason through anvil, so this one reads the
    // custom error from a dry run instead. It does not replace the original, which still runs on hardhat.
    describe('Part 2b: real relayed message passes the signature port', () => {
        const REAL_BLOCK = 22_517_700
        const REAL_MEDIATOR = '0x1715a3E4A142d8b698131108995174F37aEBA10D'
        const REAL_BRIDGE = '0xd0764FAe29E0a6a96fF685f71CfC685456D5636c'
        const relayedAbi = [
            'event RelayedMessage(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)',
            'function safeExecuteSignatures(bytes _data, bytes _signatures)',
            'function safeExecuteSignaturesWithGasLimit(bytes _data, bytes _signatures, uint32 _gas)',
            'function safeExecuteSignaturesWithAutoGasLimit(bytes _data, bytes _signatures)',
            'function relayedMessages(bytes32) view returns (bool)',
            'function messageCallStatus(bytes32) view returns (bool)',
        ]

        it('recover passes real validator signatures for a router at the real recipient; a corrupted set stops at the signatures', async function () {
            const used = await forkAt(ETHEREUM_RPCS, REAL_BLOCK, REAL_MEDIATOR)
            if (!used) {
                console.log('      skipped: no Ethereum endpoint could fork')
                return this.skip()
            }
            const iface = new ethers.Interface(relayedAbi)
            const bridge = new ethers.Contract(REAL_BRIDGE, relayedAbi, hre.ethers.provider)
            const logs = (await bridge.queryFilter(bridge.filters.RelayedMessage(null, REAL_MEDIATOR), REAL_BLOCK - 2_000, REAL_BLOCK)) as ethers.EventLog[]
            const andCall = [
                ethers.id('handleBridgedTokensAndCall(address,address,uint256,bytes)').slice(0, 10),
                ethers.id('handleNativeTokensAndCall(address,address,uint256,bytes)').slice(0, 10),
            ]
            let found: { message: string; signatures: string; messageId: string } | undefined
            for (const log of [...logs].reverse()) {
                if (!(log.args.status as boolean)) continue
                const transaction = await hre.ethers.provider.getTransaction(log.transactionHash)
                const fragment = ['safeExecuteSignatures', 'safeExecuteSignaturesWithGasLimit', 'safeExecuteSignaturesWithAutoGasLimit']
                    .map((name) => iface.getFunction(name)!)
                    .find((candidate) => candidate.selector === transaction?.data.slice(0, 10))
                if (!transaction || !fragment) continue
                const decodedCall = iface.decodeFunctionData(fragment, transaction.data)
                const bytes = ethers.getBytes(decodedCall[0])
                const inner = ethers.hexlify(bytes.slice(79 + bytes[76] + bytes[77]))
                if (!andCall.includes(inner.slice(0, 10))) continue
                found = { message: decodedCall[0], signatures: decodedCall[1], messageId: log.args.messageId as string }
                break
            }
            expect(found, 'a real relayed and-call message exists in the scan window').to.not.equal(undefined)
            expect(ethers.hexlify(ethers.getBytes(found!.message).slice(0, 32))).to.equal(found!.messageId)
            expect(await bridge.relayedMessages(found!.messageId)).to.equal(true)
            expect(await bridge.messageCallStatus(found!.messageId)).to.equal(true)
            const [deployer] = await hre.ethers.getSigners()
            const routerFactory = await hre.ethers.getContractFactory('TokenOmnibridgeRouter')
            const freshRouter = await routerFactory.deploy(REAL_MEDIATOR, WETH, deployer)
            const errorOf = (promise: Promise<unknown>) =>
                promise.then(
                    () => 'did not revert',
                    (error: any) => freshRouter.interface.parseError(error.data)?.name ?? `unparsed: ${String(error.message).slice(0, 80)}`,
                )
            // "Is this message for us?" runs before the signatures, so a router at any other address stops at
            // NotForThisRouter whatever signatures it is given. That proves nothing about the signatures.
            const corrupted = found!.signatures.slice(0, -2) + (found!.signatures.endsWith('00') ? '01' : '00')
            expect(await errorOf(freshRouter.recover.staticCall(found!.message, corrupted))).to.equal('NotForThisRouter')

            // So put the fresh router's runtime code at the real recipient. Its bridge and wrapped token are
            // immutables inside the runtime code, so they move with it; the reads below confirm it.
            const bytes = ethers.getBytes(found!.message)
            const inner = ethers.hexlify(bytes.slice(79 + bytes[76] + bytes[77]))
            const recipient = coder.decode(['address', 'address', 'uint256', 'bytes'], '0x' + inner.slice(10))[1] as string
            await rpc('anvil_setCode', [recipient, await hre.ethers.provider.getCode(freshRouter.target as string)])
            const routerAtRecipient = routerFactory.attach(recipient) as typeof freshRouter
            expect(await routerAtRecipient.bridge(), 'the bridge immutable moved with the code').to.equal(REAL_MEDIATOR)
            expect(await routerAtRecipient.wNative(), 'the wrapped token immutable moved with the code').to.equal(WETH)
            expect(await routerAtRecipient.processed(found!.messageId)).to.equal(false)

            const outcomeOf = (promise: Promise<bigint>) =>
                promise.then(
                    (outcome) => `returned ${outcome}`,
                    (error: any) => routerAtRecipient.interface.parseError(error.data)?.name ?? `unparsed: ${String(error.message).slice(0, 80)}`,
                )
            const genuine = await outcomeOf(routerAtRecipient.recover.staticCall(found!.message, found!.signatures))
            const corruptedAtRecipient = await outcomeOf(routerAtRecipient.recover.staticCall(found!.message, corrupted))
            console.log(`      real message ${found!.messageId} at recipient ${recipient}: genuine signatures ${genuine}, corrupted signatures ${corruptedAtRecipient}`)
            // Every gate before the signatures passes against the real data, the genuine signatures pass, and
            // the call reaches the payment.
            expect(genuine, 'genuine signatures reach the payment and recover the message').to.equal('returned 1')
            expect(corruptedAtRecipient).to.match(/^(SignerNotValidator|InvalidSignature|DuplicateSignature)$/)
        })
    })

    describe('Part 2: recover() pays every fee director shape', () => {
        const oneEther = ethers.parseEther('1')
        const value = oneEther / 10n
        const feeDirectorEncoding = (recipient: string, settings: bigint, limit = 0n, multiplier = 0n) =>
            coder.encode(['address', 'uint256', 'uint256', 'uint256'], [recipient, settings, limit, multiplier])

        let owner!: Awaited<ReturnType<typeof hre.ethers.getSigners>>[number]
        let validators!: ethers.HDNodeWallet[]
        let token!: any
        let mediator!: any
        let amb!: any
        let router!: any
        let messageCounter = 0
        let forked = false

        const packSignatures = (pieces: Array<{ v: string; r: string; s: string }>) =>
            '0x' +
            pieces.length.toString(16).padStart(2, '0') +
            pieces.map((piece) => piece.v).join('') +
            pieces.map((piece) => piece.r).join('') +
            pieces.map((piece) => piece.s).join('')

        const sign = async (message: string) => {
            const pieces = []
            for (const wallet of [validators[0], validators[1]]) {
                pieces.push(helpers.signatureToVRS(await wallet.signMessage(ethers.getBytes(message))))
            }
            return packSignatures(pieces)
        }

        const buildMessage = (messageId: string, innerCall: string) =>
            ethers.concat([
                messageId,
                mediator.target as string,
                mediator.target as string,
                ethers.toBeHex(2_000_000, 4),
                '0x02',
                '0x01',
                '0x00',
                '0x0171',
                '0x01',
                innerCall,
            ])

        before(async function () {
            const used = await forkAt(ETHEREUM_RPCS, ETHEREUM_PART_TWO_BLOCK, WETH)
            if (!used) {
                console.log('      Part 2 skipped: no Ethereum endpoint could fork')
                return this.skip()
            }
            forked = true
            ;[owner] = await hre.ethers.getSigners()
            validators = [0, 1, 2].map(() => ethers.Wallet.createRandom())
            const PermittableToken = await setup.requirePrecompiled('PermittableToken')
            const ForeignOmnibridge = await hre.ethers.getContractFactory('ForeignOmnibridge')
            const AMBMock = await hre.ethers.getContractFactory('AMBMock')
            const WETHFactory = await hre.ethers.getContractFactory('WETH')
            const TokenFactory = await hre.ethers.getContractFactory('TokenFactory')
            const BridgeValidators = await hre.ethers.getContractFactory('BridgeValidators')
            const tokenImage = await PermittableToken.deploy('TEST', 'TST', 18, 1337)
            const tokenFactory = await TokenFactory.deploy(owner, tokenImage)
            mediator = await ForeignOmnibridge.deploy(' on Testnet')
            const bridgeValidators = await BridgeValidators.deploy()
            await bridgeValidators.initialize(2, validators.map((wallet) => wallet.address), owner)
            amb = await AMBMock.deploy(bridgeValidators)
            await mediator.initialize(
                amb,
                mediator,
                [oneEther * 100n, oneEther * 10n, 1n],
                [oneEther * 100n, oneEther * 10n],
                1000000,
                owner,
                tokenFactory,
            )
            token = await WETHFactory.deploy()
            const routerFactory = await hre.ethers.getContractFactory('TokenOmnibridgeRouter')
            router = await routerFactory.deploy(mediator, token, owner)
        })

        // Real fee director data from Part 1 where it decoded. Strand #6 unwraps to native, strand #9 stays in the token.
        const realDirector = (id: number) => {
            const result = decodedByCase.get(id)
            return result && 'decoded' in result ? result.decoded : undefined
        }

        type Shape = {
            name: string
            asNative: boolean
            data: () => { data: string; recipient: string } | undefined
        }
        const freshRecipient = () => ethers.Wallet.createRandom().address
        const shapes: Shape[] = [
            {
                name: 'gas plus, real strand #6 data (unwrap to native)',
                asNative: true,
                data: () => {
                    const real = realDirector(6)
                    return real && { data: real.feeDirectorData, recipient: real.feeDirector.recipient }
                },
            },
            {
                name: 'gas plus, real strand #9 data (stays as the token)',
                asNative: false,
                data: () => {
                    const real = realDirector(9)
                    return real && { data: real.feeDirectorData, recipient: real.feeDirector.recipient }
                },
            },
            {
                name: 'percent of the value, unwrap to native',
                asNative: true,
                data: () => {
                    const recipient = freshRecipient()
                    return { recipient, data: feeDirectorEncoding(recipient, unwrapBit | percentFeeBit, 0n, ethers.parseEther('0.1')) }
                },
            },
            {
                name: 'percent of the value, stays as the token',
                asNative: false,
                data: () => {
                    const recipient = freshRecipient()
                    return { recipient, data: feeDirectorEncoding(recipient, percentFeeBit, 0n, ethers.parseEther('0.1')) }
                },
            },
            {
                name: 'fixed fee, unwrap to native',
                asNative: true,
                data: () => {
                    const recipient = freshRecipient()
                    return { recipient, data: feeDirectorEncoding(recipient, unwrapBit | fixedFeeBit, ethers.parseEther('0.01')) }
                },
            },
            {
                name: 'fixed fee, stays as the token',
                asNative: false,
                data: () => {
                    const recipient = freshRecipient()
                    return { recipient, data: feeDirectorEncoding(recipient, fixedFeeBit, ethers.parseEther('0.01')) }
                },
            },
            {
                name: 'legacy 20-byte unwrap form',
                asNative: true,
                data: () => {
                    const recipient = freshRecipient()
                    return { recipient, data: recipient }
                },
            },
        ]

        for (const shape of shapes) {
            it(`recovers ${shape.name}: full value once, no tip, second recover refused`, async function () {
                if (!forked) return this.skip()
                const built = shape.data()
                if (!built) {
                    console.log(`      cannot build "${shape.name}": the real strand did not decode`)
                    return this.skip()
                }
                await isolated(async () => {
                    const { data, recipient } = built
                    const code = await hre.ethers.provider.getCode(recipient)
                    expect(code, 'the end recipient is a plain account').to.equal('0x')
                    const messageId = ethers.keccak256(ethers.toUtf8Bytes(`part-two-${messageCounter++}`))
                    const innerCall = ethers.concat([
                        mediatorInterface.getFunction('handleNativeTokensAndCall')!.selector,
                        coder.encode(['address', 'address', 'uint256', 'bytes'], [token.target, router.target, value, data]),
                    ])
                    // The stranded state: the tokens sit in the router and the bridge says the message was delivered.
                    await token.deposit({ value })
                    await token.transfer(router, value)
                    await amb.executeMessageCall(token, router, token.interface.encodeFunctionData('deposit'), messageId, 100_000n)
                    expect(await amb.relayedMessages(messageId)).to.equal(true)
                    expect(await amb.messageCallStatus(messageId)).to.equal(true)
                    expect(await router.processed(messageId)).to.equal(false)
                    expect(await token.balanceOf(router)).to.equal(value)

                    const message = buildMessage(messageId, innerCall)
                    const signatures = await sign(message)
                    const nativeBefore = await hre.ethers.provider.getBalance(recipient)
                    const tokenBefore = (await token.balanceOf(recipient)) as bigint

                    const receipt = await (await router.recover(message, signatures)).wait()
                    const recovered = receipt.logs
                        .map((log: ethers.Log) => router.interface.parseLog(log))
                        .filter((parsed: ethers.LogDescription | null) => parsed?.name === 'DeliveryRecovered')
                    expect(recovered.length, 'one DeliveryRecovered event').to.equal(1)
                    expect(recovered[0].args[0]).to.equal(messageId)
                    expect(recovered[0].args[1]).to.equal(await token.getAddress())
                    expect(recovered[0].args[3], 'the event reports the full value').to.equal(value)

                    const nativeGain = (await hre.ethers.provider.getBalance(recipient)) - nativeBefore
                    const tokenGain = ((await token.balanceOf(recipient)) as bigint) - tokenBefore
                    console.log(
                        `      ${shape.name}: recipient native +${nativeGain}, token +${tokenGain} (value ${value}), router token ${await token.balanceOf(router)}`,
                    )
                    expect(shape.asNative ? nativeGain : tokenGain, 'recipient paid the full value').to.equal(value)
                    expect(shape.asNative ? tokenGain : nativeGain, 'nothing in the other form').to.equal(0n)
                    expect(await token.balanceOf(router), 'router keeps nothing').to.equal(0n)
                    expect(await hre.ethers.provider.getBalance(router), 'router keeps no native coin').to.equal(0n)
                    expect(await router.processed(messageId)).to.equal(true)
                    // A second recover is a lost race: it returns AlreadyHandled (enum value 2) and pays nothing.
                    // Both a dry run and a mined attempt are checked: the mined attempt succeeds, emits nothing,
                    // and changes no balance.
                    const dryRunOutcome = await router.recover.staticCall(message, signatures)
                    expect(dryRunOutcome, 'second recover returns AlreadyHandled').to.equal(2n)
                    const second = await (await router.recover(message, signatures, { gasLimit: 1_000_000n })).wait()
                    expect(second.status, 'the mined second recover succeeds').to.equal(1)
                    expect(second.logs.length, 'the mined second recover emits nothing').to.equal(0)
                    expect((await token.balanceOf(recipient)) - tokenBefore).to.equal(tokenGain)
                    expect((await hre.ethers.provider.getBalance(recipient)) - nativeBefore).to.equal(nativeGain)
                })
            })
        }
    })
})
