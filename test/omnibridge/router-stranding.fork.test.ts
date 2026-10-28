import hre from 'hardhat'
import { expect } from 'chai'
import * as ethers from 'ethers'

// Ethereum mainnet, pinned. Read only: the fork lives in the Hardhat process and nothing is broadcast.
const RPC_CANDIDATES = ['https://rpc-ethereum.g4mm4.io', 'https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com']
const BLOCK = 22_517_700
// The deployed router did not exist at the block above (it has no code there), so the strand
// proof forks later, at a block where the router is live.
const ROUTER_LIVE_BLOCK = 23_000_000
// The scan for a real relayed message looks this many blocks back from the pinned block.
const SCAN_WINDOW = 2_000

// The foreign Arbitrary Message Bridge proxy.
const BRIDGE = '0xd0764FAe29E0a6a96fF685f71CfC685456D5636c'
// The main foreign mediator proxy. Real deployed bytecode.
const MEDIATOR = '0x1715a3E4A142d8b698131108995174F37aEBA10D'
// The real, currently deployed delivery router (the version without recovery).
const DEPLOYED_ROUTER = '0x2Ed02372C3efF1F239B22a901ceA8Cf6fbf82d8d'
// Wrapped ether. The mediator holds it in custody, registered as a native token.
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

const coder = ethers.AbiCoder.defaultAbiCoder()
const unwrapFlag = 0b0010n

const mediatorAbi = [
    'function handleNativeTokensAndCall(address _token, address _recipient, uint256 _value, bytes memory _data) external',
    'function mediatorContractOnOtherSide() view returns (address)',
    'function isRegisteredAsNativeToken(address) view returns (bool)',
    'function bridgeContract() view returns (address)',
]
const erc20Abi = ['function balanceOf(address) view returns (uint256)']
const routerAbi = ['function bridge() view returns (address)', 'function wNative() view returns (address)']
const bridgeAbi = [
    'event RelayedMessage(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)',
    'function safeExecuteSignatures(bytes _data, bytes _signatures)',
    'function safeExecuteSignaturesWithGasLimit(bytes _data, bytes _signatures, uint32 _gas)',
    'function safeExecuteSignaturesWithAutoGasLimit(bytes _data, bytes _signatures)',
    'function relayedMessages(bytes32) view returns (bool)',
    'function messageCallStatus(bytes32) view returns (bool)',
    'function validatorContract() view returns (address)',
]

/** Forks Ethereum from the first working endpoint. Returns an error message when none works. */
const forkEthereum = async (blockNumber: number): Promise<string | undefined> => {
    let lastError = 'no endpoint tried'
    for (const rpc of RPC_CANDIDATES) {
        try {
            await hre.network.provider.request({
                method: 'hardhat_reset',
                params: [{ forking: { jsonRpcUrl: rpc, blockNumber } }],
            })
            const mediatorCode = await hre.ethers.provider.getCode(MEDIATOR)
            const bridgeCode = await hre.ethers.provider.getCode(BRIDGE)
            if (mediatorCode === '0x') throw new Error('mediator has no code at the pinned block')
            if (bridgeCode === '0x') throw new Error('bridge has no code at the pinned block')
            return undefined
        } catch (error) {
            lastError = (error as Error).message.slice(0, 160)
        }
    }
    return lastError
}

const skipForkFailure = async (message: string) => {
    console.log(`      skipping, no fork RPC worked: ${message}`)
    await hre.network.provider.request({ method: 'hardhat_reset', params: [] })
}

describe('Router stranding against the real deployed contracts on an Ethereum fork', function () {
    this.timeout(600_000)

    describe('E: a low gas budget strands tokens in the real router', () => {
        let forked = false
        let signer!: ethers.Signer
        let relayer: any
        let mediator: any
        let weth: any

        before(async function () {
            const failure = await forkEthereum(ROUTER_LIVE_BLOCK)
            if (failure) {
                await skipForkFailure(failure)
                return this.skip()
            }
            forked = true
            signer = (await hre.ethers.getSigners())[0]
            mediator = new ethers.Contract(MEDIATOR, mediatorAbi, hre.ethers.provider)
            weth = new ethers.Contract(WETH, erc20Abi, hre.ethers.provider)

            // The mediator trusts only its bridge, and the bridge only relays for the other side's mediator.
            const otherSideMediator: string = await mediator.mediatorContractOnOtherSide()
            const callerFactory = await hre.ethers.getContractFactory('GasLimitedCaller')
            const callerArtifact = await hre.artifacts.readArtifact('GasLimitedCaller')
            await hre.network.provider.send('hardhat_setCode', [BRIDGE, callerArtifact.deployedBytecode])
            relayer = new ethers.Contract(BRIDGE, callerFactory.interface, signer)
            await (await relayer.setMessageSender(otherSideMediator)).wait()
            await (await relayer.setMessageId(ethers.keccak256(ethers.toUtf8Bytes('router-stranding-test')))).wait()
        })

        it('lands tokens in the router while the mediator reports success, and pays in full at high gas', async function () {
            if (!forked) return this.skip()
            const router = new ethers.Contract(DEPLOYED_ROUTER, routerAbi, hre.ethers.provider)
            expect(await hre.ethers.provider.getCode(DEPLOYED_ROUTER)).to.not.equal('0x')
            // the router must really be wired to this mediator and this token, or the test says nothing
            expect((await router.bridge()).toLowerCase()).to.equal(MEDIATOR.toLowerCase())
            expect((await router.wNative()).toLowerCase()).to.equal(WETH.toLowerCase())
            expect(await mediator.isRegisteredAsNativeToken(WETH)).to.equal(true)

            const value = ethers.parseEther('0.01')
            const custody: bigint = await weth.balanceOf(MEDIATOR)
            expect(custody >= value, 'the mediator holds enough custody').to.equal(true)

            const recipient = ethers.Wallet.createRandom().address
            const data = coder.encode(['address', 'uint256', 'uint256', 'uint256'], [recipient, unwrapFlag, 0n, 0n])
            const callData = mediator.interface.encodeFunctionData('handleNativeTokensAndCall', [
                WETH,
                DEPLOYED_ROUTER,
                value,
                data,
            ])

            const attempt = async (gas: bigint) => {
                const routerBefore: bigint = await weth.balanceOf(DEPLOYED_ROUTER)
                const recipientBefore = await hre.ethers.provider.getBalance(recipient)
                const [mediatorOk] = await relayer.relay.staticCall(MEDIATOR, callData, gas)
                await (await relayer.relay(MEDIATOR, callData, gas, { gasLimit: 30_000_000n })).wait()
                return {
                    mediatorOk: mediatorOk as boolean,
                    routerGain: ((await weth.balanceOf(DEPLOYED_ROUTER)) as bigint) - routerBefore,
                    recipientGain: (await hre.ethers.provider.getBalance(recipient)) - recipientBefore,
                }
            }

            // Sweep upward until the mediator succeeds. Just above that point the router callback
            // gets too little gas, so the transfer into the router stands but the delivery does not.
            const { takeSnapshot } = await import('@nomicfoundation/hardhat-network-helpers')
            let strandedAt: bigint | undefined
            for (let gas = 60_000n; gas <= 400_000n; gas += 2_000n) {
                const snapshot = await takeSnapshot()
                const outcome = await attempt(gas)
                if (outcome.mediatorOk && outcome.routerGain === value && outcome.recipientGain === 0n) {
                    strandedAt = gas
                    console.log(`      strand: gas budget ${gas}, router gained ${outcome.routerGain} wei of WETH, mediator reported success, recipient got 0`)
                    break
                }
                await snapshot.restore()
            }
            expect(strandedAt !== undefined, 'some gas budget strands the delivery').to.equal(true)

            // Control: the same call with a large budget delivers to the recipient and leaves nothing behind.
            const control = await attempt(15_000_000n)
            expect(control.mediatorOk).to.equal(true)
            expect(control.recipientGain).to.equal(value)
            expect(control.routerGain).to.equal(0n)
        })
    })

    describe('F: signature-port ground truth against a real relayed message', () => {
        let forked = false

        before(async function () {
            const failure = await forkEthereum(BLOCK)
            if (failure) {
                await skipForkFailure(failure)
                return this.skip()
            }
            forked = true
        })

        /** The inner call selectors of the two mediator callbacks that carry a fee director. */
        const andCallSelectors = [
            ethers.id('handleBridgedTokensAndCall(address,address,uint256,bytes)').slice(0, 10),
            ethers.id('handleNativeTokensAndCall(address,address,uint256,bytes)').slice(0, 10),
        ]

        /** Reads the real message and signatures from the calldata of the transaction that relayed it. */
        const decodeRelayCalldata = (bridgeInterface: ethers.Interface, input: string) => {
            const selector = input.slice(0, 10)
            for (const name of [
                'safeExecuteSignatures',
                'safeExecuteSignaturesWithGasLimit',
                'safeExecuteSignaturesWithAutoGasLimit',
            ]) {
                const fragment = bridgeInterface.getFunction(name)!
                if (fragment.selector !== selector) continue
                const decoded = bridgeInterface.decodeFunctionData(fragment, input)
                return { message: decoded[0] as string, signatures: decoded[1] as string }
            }
            return undefined
        }

        it('recover passes real signature verification and stops at NotForThisRouter', async function () {
            if (!forked) return this.skip()
            const bridgeInterface = new ethers.Interface(bridgeAbi)
            const bridge = new ethers.Contract(BRIDGE, bridgeAbi, hre.ethers.provider)
            const logs = await bridge.queryFilter(
                bridge.filters.RelayedMessage(null, MEDIATOR),
                BLOCK - SCAN_WINDOW,
                BLOCK,
            )
            console.log(`      scanned ${logs.length} real RelayedMessage logs for the mediator in blocks ${BLOCK - SCAN_WINDOW}..${BLOCK}`)

            let found: { message: string; signatures: string; messageId: string; transactionHash: string } | undefined
            for (const log of [...logs].reverse()) {
                const transaction = await hre.ethers.provider.getTransaction(log.transactionHash)
                const calldata = transaction ? decodeRelayCalldata(bridgeInterface, transaction.data) : undefined
                if (!calldata) continue
                const bytes = ethers.getBytes(calldata.message)
                const innerCall = ethers.hexlify(bytes.slice(79 + bytes[76] + bytes[77]))
                if (!andCallSelectors.includes(innerCall.slice(0, 10))) continue
                // the status must be true: recover requires the bridge to have recorded success
                if (!(log.args.status as boolean)) continue
                found = { ...calldata, messageId: log.args.messageId as string, transactionHash: log.transactionHash }
                break
            }
            if (!found) {
                console.log('      no real relayed "and call" message found in the scan window; leaving this test as a skip')
                return this.skip()
            }
            console.log(`      real message id ${found.messageId}`)
            console.log(`      relayed by transaction ${found.transactionHash}`)

            // The message id inside the bytes must equal the id the bridge logged: this checks the layout offset.
            expect(ethers.hexlify(ethers.getBytes(found.message).slice(0, 32))).to.equal(found.messageId)
            // The bridge itself recorded the message as relayed and successful.
            expect(await bridge.relayedMessages(found.messageId)).to.equal(true)
            expect(await bridge.messageCallStatus(found.messageId)).to.equal(true)

            const [owner] = await hre.ethers.getSigners()
            const routerFactory = await hre.ethers.getContractFactory('TokenOmnibridgeRouter')
            const freshRouter = await routerFactory.deploy(MEDIATOR, WETH, owner)

            // Reaching NotForThisRouter proves every earlier gate passed against the real data:
            // the executor offset, the real validator signatures, relayedMessages, messageCallStatus,
            // the processed flag, and the selector. Only the recipient check is left, and the real
            // recipient is not this fresh router.
            await expect(freshRouter.recover(found.message, found.signatures)).to.be.revertedWithCustomError(
                freshRouter,
                'NotForThisRouter',
            )

            // The test can fail: a corrupted signature set must stop earlier, with a signature error.
            const corrupted = found.signatures.slice(0, -2) + (found.signatures.endsWith('00') ? '01' : '00')
            const corruptedOutcome = await freshRouter.recover.staticCall(found.message, corrupted).then(
                () => 'did not revert',
                (error: Error) => error.message,
            )
            expect(corruptedOutcome).to.not.contain('NotForThisRouter')
            expect(corruptedOutcome).to.match(/SignerNotValidator|InvalidSignature|DuplicateSignature/)
        })
    })
})
