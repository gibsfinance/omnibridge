import hre from 'hardhat'
import { expect } from 'chai'
import * as ethers from 'ethers'

// Ethereum mainnet, pinned. Read only: the fork lives in the Hardhat process and nothing
// is broadcast to a live network.
const RPC_CANDIDATES = ['https://rpc-ethereum.g4mm4.io', 'https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com']
const BLOCK = 22_517_700

// The foreign Arbitrary Message Bridge proxy. Its code is replaced on the fork with a
// gas-limited caller helper, so every onlyMediator call still arrives with
// msg.sender == this address, but the caller controls the exact gas the mediator receives.
const BRIDGE = '0xd0764FAe29E0a6a96fF685f71CfC685456D5636c'
// The main foreign mediator proxy. This is the real deployed bytecode under test.
const MEDIATOR = '0x1715a3E4A142d8b698131108995174F37aEBA10D'
// Wrapped ether. The mediator already holds a large custody balance of it, registered as
// a native token, so handleNativeTokensAndCall can unlock it without any extra setup.
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

// The gas budgets to sweep, mimicking a bridge that forwards a limited amount of gas to
// the mediator call. The dense run between 60,000 and 100,000 locates the exact point
// where each recipient behaviour starts to succeed, so a gap between recipients would
// show up as a different threshold rather than being hidden inside one coarse step.
const GAS_BUDGETS = [
    40_000n,
    50_000n,
    55_000n,
    60_000n,
    65_000n,
    70_000n,
    75_000n,
    80_000n,
    85_000n,
    90_000n,
    95_000n,
    100_000n,
    150_000n,
    300_000n,
    1_000_000n,
    15_000_000n,
]

const mediatorAbi = [
    'function handleNativeTokensAndCall(address _token, address _recipient, uint256 _value, bytes memory _data) external',
    'function mediatorContractOnOtherSide() view returns (address)',
    'function isRegisteredAsNativeToken(address) view returns (bool)',
    'function executionDailyLimit(address) view returns (uint256)',
    'function executionMaxPerTx(address) view returns (uint256)',
]
const erc20Abi = ['function balanceOf(address) view returns (uint256)']

type Row = {
    recipient: string
    gas: bigint
    relayOk: boolean
    delivered: boolean
}

describe('Deployed foreign mediator callback behavior on an Ethereum fork', function () {
    this.timeout(300_000)
    let forked = false
    let signer!: Awaited<ReturnType<typeof hre.ethers.getSigners>>[number]
    let gasLimitedCallerAtBridge: any
    let mediator: any
    let weth: any
    let revertPlain: any
    let revertBomb: any
    let gasEaterThenRevert: any
    const transferValue = ethers.parseEther('1')

    const tryForkOnce = async (rpc: string) => {
        await hre.network.provider.request({
            method: 'hardhat_reset',
            params: [{ forking: { jsonRpcUrl: rpc, blockNumber: BLOCK } }],
        })
        const mediatorCode = await hre.ethers.provider.getCode(MEDIATOR)
        const bridgeCode = await hre.ethers.provider.getCode(BRIDGE)
        if (mediatorCode === '0x') throw new Error('mediator has no code at the pinned block')
        if (bridgeCode === '0x') throw new Error('bridge has no code at the pinned block')
    }

    before(async function () {
        let lastError: Error | undefined
        for (const rpc of RPC_CANDIDATES) {
            try {
                await tryForkOnce(rpc)
                forked = true
                break
            } catch (error) {
                lastError = error as Error
            }
        }
        if (!forked) {
            console.log(`      skipping, no fork RPC worked: ${lastError?.message.slice(0, 160)}`)
            await hre.network.provider.request({ method: 'hardhat_reset', params: [] })
            return this.skip()
        }

        const signers = await hre.ethers.getSigners()
        signer = signers[0]

        // Read the real mediator's own view of its counterparty before any code is
        // replaced, so the spoofed bridge can answer `messageSender()` with the one
        // value that keeps the mediator's `onlyMediator` check passing.
        const liveMediator = new ethers.Contract(MEDIATOR, mediatorAbi, hre.ethers.provider)
        const otherSideMediator: string = await liveMediator.mediatorContractOnOtherSide()

        const callerFactory = await hre.ethers.getContractFactory('GasLimitedCaller')
        const callerArtifact = await hre.artifacts.readArtifact('GasLimitedCaller')
        await hre.network.provider.send('hardhat_setCode', [BRIDGE, callerArtifact.deployedBytecode])
        gasLimitedCallerAtBridge = new ethers.Contract(BRIDGE, callerFactory.interface, signer)
        await (await gasLimitedCallerAtBridge.setMessageSender(otherSideMediator)).wait()
        // The mediator also reads bridgeContract().messageId() while recording the transfer
        // (selector 0x669f618b). Any fixed value keeps that read passing.
        await (await gasLimitedCallerAtBridge.setMessageId(ethers.keccak256(ethers.toUtf8Bytes('mediator-callback-behavior-test')))).wait()

        mediator = new ethers.Contract(MEDIATOR, mediatorAbi, hre.ethers.provider)
        weth = new ethers.Contract(WETH, erc20Abi, hre.ethers.provider)

        const revertPlainFactory = await hre.ethers.getContractFactory('RevertPlain')
        revertPlain = await revertPlainFactory.deploy()
        const revertBombFactory = await hre.ethers.getContractFactory('RevertBomb')
        revertBomb = await revertBombFactory.deploy()
        const gasEaterFactory = await hre.ethers.getContractFactory('GasEaterThenRevert')
        gasEaterThenRevert = await gasEaterFactory.deploy()

        expect(await mediator.isRegisteredAsNativeToken(WETH)).to.equal(true)
    })

    it('reports whether the mediator swallows or surfaces each recipient failure, across a gas sweep', async function () {
        if (!forked) return this.skip()

        const recipients: Array<{ name: string; address: string }> = [
            { name: 'RevertPlain (revert, no data)', address: await revertPlain.getAddress() },
            { name: 'RevertBomb (revert, ~1 MiB return data)', address: await revertBomb.getAddress() },
            { name: 'GasEaterThenRevert (burn gas, then revert)', address: await gasEaterThenRevert.getAddress() },
        ]

        const data = '0x' + '11'.repeat(128)
        const rows: Row[] = []

        for (const recipient of recipients) {
            for (const gas of GAS_BUDGETS) {
                const before: bigint = await weth.balanceOf(recipient.address)
                const callData = mediator.interface.encodeFunctionData('handleNativeTokensAndCall', [
                    WETH,
                    recipient.address,
                    transferValue,
                    data,
                ])

                // Read the ok/gasLeftAfter return value with a static call first, at the
                // same starting state the real transaction below will also start from.
                let relayOk = false
                try {
                    const [ok] = await gasLimitedCallerAtBridge.relay.staticCall(MEDIATOR, callData, gas)
                    relayOk = ok
                } catch {
                    relayOk = false
                }

                // Then mine the same call for real, to observe whether tokens actually moved.
                const tx = await gasLimitedCallerAtBridge.relay(MEDIATOR, callData, gas, { gasLimit: 30_000_000n })
                await tx.wait()

                const after: bigint = await weth.balanceOf(recipient.address)
                const delivered = after > before
                rows.push({ recipient: recipient.name, gas, relayOk, delivered })
            }
        }

        console.log('')
        console.log('  recipient behaviour | gas budget | relay reported ok | tokens delivered')
        console.log('  ---------------------------------------------------------------------')
        for (const row of rows) {
            console.log(`  ${row.recipient} | ${row.gas.toString()} | ${row.relayOk} | ${row.delivered}`)
        }
        console.log('')

        expect(rows.length).to.equal(recipients.length * GAS_BUDGETS.length)
    })
})
