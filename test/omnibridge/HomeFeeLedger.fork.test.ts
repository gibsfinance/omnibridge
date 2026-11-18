import hre from 'hardhat'
import { expect } from 'chai'
import * as ethers from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { feeLedgerInstruction as instruction } from '../helpers/helpers'

// PulseChain mainnet, pinned. Read only: the fork lives in the Hardhat process and nothing is broadcast.
const RPC = 'https://rpc.pulsechain.com'
const BLOCK = 27_540_000
const MAIN_MEDIATOR = '0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef'
const WPLS_MEDIATOR = '0x0e18d0d556b652794EF12Bf68B2dC857EF5f3996'
const WPLS = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'
// USDC from Ethereum, bridged to PulseChain (6 decimals)
const USDC = '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07'
// the fee, in parts of 10_000, that the real mediators keep on a home to foreign transfer (observed on the fork)
const MEDIATOR_FEE = 30n
const ETHEREUM_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
// the home Arbitrary Message Bridge that the main mediator reads as bridgeContract() (confirmed on the fork)
const HOME_BRIDGE = '0x6ef79FD6f9f840264332884240539Ed7A2dA8b2b'
// the foreign mediator, which the home mediator requires as the message sender (mediatorContractOnOtherSide)
const FOREIGN_MEDIATOR = '0x1715a3E4A142d8b698131108995174F37aEBA10D'
// The bridge implementation keeps messageSender in the plain slot keccak256("messageSender"). Traced on the fork.
const MESSAGE_SENDER_SLOT = ethers.id('messageSender')

const mediatorAbi = [
    'function isTokenRegistered(address) view returns (bool)',
    'function nativeTokenAddress(address) view returns (address)',
    'event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)',
]
const handlerAbi = [
    'function handleBridgedTokensAndCall(address _token, address _recipient, uint256 _value, bytes _data)',
]
const bridgeAbi = ['function messageSender() view returns (address)']
const tokensBridgedAbi = [
    'event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId)',
]
const tokenAbi = [
    'function balanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function transfer(address,uint256) returns (bool)',
    'function mint(address,uint256) returns (bool)',
    'function deposit() payable',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
]

describe('HomeFeeLedger on a PulseChain fork', function () {
    this.timeout(300_000)
    let ledger: any
    let usdc: any
    let signers!: HardhatEthersSigner[]
    let user!: HardhatEthersSigner
    let collector!: HardhatEthersSigner
    let recipient!: HardhatEthersSigner
    let partnerPayout!: HardhatEthersSigner
    let forked = false

    const impersonate = async (address: string) => {
        await hre.network.provider.send('hardhat_setBalance', [address, '0x56BC75E2D63100000'])
        await hre.network.provider.request({ method: 'hardhat_impersonateAccount', params: [address] })
        return hre.ethers.getSigner(address)
    }
    // Writes the sender the real bridge sets while it runs a message, then reads it back through the real getter.
    const setMessageSender = async (sender: string) => {
        await hre.network.provider.send('hardhat_setStorageAt', [HOME_BRIDGE, MESSAGE_SENDER_SLOT, ethers.zeroPadValue(sender, 32)])
        const read = ethers.getAddress(await new ethers.Contract(HOME_BRIDGE, bridgeAbi, hre.ethers.provider).messageSender())
        expect(read).to.equal(ethers.getAddress(sender === ethers.ZeroAddress ? ethers.ZeroAddress : sender))
    }
    const bridgingEvents = (receipt: ethers.ContractTransactionReceipt, mediator: string) => {
        const iface = new ethers.Interface(mediatorAbi)
        return receipt.logs
            .filter((log) => log.address.toLowerCase() === mediator.toLowerCase())
            .flatMap((log) => {
                const parsed = iface.parseLog(log)
                return parsed?.name === 'TokensBridgingInitiated' ? [parsed] : []
            })
    }

    before(async function () {
        try {
            await hre.network.provider.request({
                method: 'hardhat_reset',
                params: [{ forking: { jsonRpcUrl: RPC, blockNumber: BLOCK } }],
            })
            const code = await hre.ethers.provider.getCode(MAIN_MEDIATOR)
            if (code === '0x') throw new Error('mediator has no code at the pinned block')
        } catch (error) {
            console.log(`      skipping, the fork failed: ${(error as Error).message.slice(0, 120)}`)
            await hre.network.provider.request({ method: 'hardhat_reset', params: [] })
            return this.skip()
        }
        forked = true
        signers = await hre.ethers.getSigners()
        ;[, user, collector, recipient, partnerPayout] = signers
        usdc = new ethers.Contract(USDC, tokenAbi, user)
        const factory = await hre.ethers.getContractFactory('HomeFeeLedger')
        ledger = await factory.deploy([MAIN_MEDIATOR, WPLS_MEDIATOR], WPLS, collector, signers[7])
    })

    after(async () => {
        if (!forked) return
        // leave the in-process network as the other test files expect it
        await hre.network.provider.request({ method: 'hardhat_reset', params: [] })
    })

    it('is looking at the real USDC and the real mediators', async () => {
        expect(await usdc.symbol()).to.equal('USDC')
        expect(await usdc.decimals()).to.equal(6n)
        const main = new ethers.Contract(MAIN_MEDIATOR, mediatorAbi, hre.ethers.provider)
        expect(await main.isTokenRegistered(USDC)).to.equal(true)
        expect(ethers.getAddress(await main.nativeTokenAddress(USDC))).to.equal(ETHEREUM_USDC)
        expect(await ledger.isMediator(MAIN_MEDIATOR)).to.equal(true)
        expect(await ledger.isMediator(WPLS_MEDIATOR)).to.equal(true)
    })

    it('relays USDC through the main mediator and bridges amount minus fees', async () => {
        const amount = 1_000n * 10n ** 6n
        const mediator = await impersonate(MAIN_MEDIATOR)
        // the mediator is the minter of its bridged tokens
        await usdc.connect(mediator).mint(user.address, amount)
        await usdc.approve(ledger, amount)
        const supplyBefore = await usdc.totalSupply()
        const tx = await ledger.connect(user).relay(MAIN_MEDIATOR, USDC, amount, recipient.address, '0x', {
            feeRateE18: 3n * 10n ** 15n,
            partner: partnerPayout.address,
            partnerRateE18: 5n * 10n ** 15n,
        })
        const receipt = await tx.wait()
        console.log(`      outbound relay gas on the fork: ${receipt.gasUsed}`)
        const gibsFee = (amount * 30n) / 10_000n
        const partnerFee = (amount * 50n) / 10_000n
        const rest = amount - gibsFee - partnerFee
        const events = bridgingEvents(receipt, MAIN_MEDIATOR)
        expect(events.length).to.equal(1)
        expect(events[0].args.token).to.equal(USDC)
        expect(events[0].args.sender).to.equal(await ledger.getAddress())
        // the real mediator takes its own 0.3% home fee before it reports the value, so the event is net of it
        expect(events[0].args.value).to.equal(rest - (rest * MEDIATOR_FEE) / 10_000n)
        expect(await ledger.owed(USDC, collector)).to.equal(gibsFee)
        expect(await ledger.owed(USDC, partnerPayout)).to.equal(partnerFee)
        expect(await usdc.balanceOf(ledger)).to.equal(gibsFee + partnerFee)
        // the mediator pulled all of `rest` from the ledger: only the credited fees are left in it
        console.log(`      supply change: ${supplyBefore - (await usdc.totalSupply())} of rest ${rest}`)
    })

    // stand-in seam: the mediator address calls the ledger directly. The next case uses the real bridge and handler.
    it('splits an inbound delivery when the mediator address calls the ledger directly', async () => {
        const value = 500n * 10n ** 6n
        const mediator = await impersonate(MAIN_MEDIATOR)
        // what the real mediator does: mint to the recipient, then call back and ignore the result
        await usdc.connect(mediator).mint(await ledger.getAddress(), value)
        const before = await usdc.balanceOf(recipient)
        const owedBefore = await ledger.owed(USDC, collector)
        const tx = await ledger.connect(mediator).onTokenBridged(USDC, value, instruction(recipient.address, { feeRate: 3n * 10n ** 15n, partner: partnerPayout.address, partnerRate: 5n * 10n ** 15n }))
        const receipt = await tx.wait()
        console.log(`      inbound split gas on the fork: ${receipt.gasUsed}`)
        const gibsFee = (value * 30n) / 10_000n
        const partnerFee = (value * 50n) / 10_000n
        expect((await usdc.balanceOf(recipient)) - before).to.equal(value - gibsFee - partnerFee)
        expect((await ledger.owed(USDC, collector)) - owedBefore).to.equal(gibsFee)
        expect(await ledger.owed(USDC, partnerPayout)).to.equal((value * 50n) / 10_000n + (1_000n * 10n ** 6n * 50n) / 10_000n)
    })

    it('delivers USDC through the real home mediator handler and the real bridge', async function () {
        // the honest seam: the real bridge calls the real mediator handler, which mints to the ledger and calls it back.
        // The only state set by hand is the bridge's messageSender, which the real bridge sets while it runs a message.
        const fresh = await (await hre.ethers.getContractFactory('HomeFeeLedger')).deploy(
            [MAIN_MEDIATOR, WPLS_MEDIATOR], WPLS, collector, signers[7],
        )
        const freshAddress = await fresh.getAddress()
        const value = 500n * 10n ** 6n
        const partnerRate = 5n * 10n ** 15n
        const feeRate = 3n * 10n ** 15n
        const data = instruction(recipient.address, { feeRate, partner: partnerPayout.address, partnerRate })
        const before = await usdc.balanceOf(recipient)
        const bridge = await impersonate(HOME_BRIDGE)
        await setMessageSender(FOREIGN_MEDIATOR)
        let receipt: ethers.ContractTransactionReceipt
        try {
            const handler = new ethers.Contract(MAIN_MEDIATOR, handlerAbi, bridge)
            receipt = await (await handler.handleBridgedTokensAndCall(ETHEREUM_USDC, freshAddress, value, data)).wait()
        } finally {
            await setMessageSender(ethers.ZeroAddress)
        }
        const minted = new ethers.Interface(tokensBridgedAbi)
        const bridged = receipt.logs
            .filter((log) => log.address.toLowerCase() === MAIN_MEDIATOR.toLowerCase())
            .flatMap((log) => {
                const parsed = minted.parseLog(log)
                return parsed?.name === 'TokensBridged' ? [parsed.args.value as bigint] : []
            })
        expect(bridged.length).to.equal(1)
        // the mediator may take its own fee before it mints, so the ledger receives the reported value, which may be less than `value`
        console.log(`      inbound mediator fee on the fork: ${value - bridged[0]} of ${value}`)
        expect(bridged[0]).to.be.greaterThan(0n).and.at.most(value)
        const gibsFee = (bridged[0] * 30n) / 10_000n
        const partnerFee = (bridged[0] * 50n) / 10_000n
        const toRecipient = bridged[0] - gibsFee - partnerFee
        const delivered = receipt.logs
            .filter((log) => log.address.toLowerCase() === freshAddress.toLowerCase())
            .map((log) => fresh.interface.parseLog(log))
            .find((parsed: any) => parsed?.name === 'Delivered')
        expect(delivered, 'the callback must reach the ledger').to.not.equal(undefined)
        expect(delivered!.args.mediator).to.equal(MAIN_MEDIATOR)
        expect(delivered!.args.token).to.equal(USDC)
        expect(delivered!.args.recipient).to.equal(recipient.address)
        // value is the gross amount the mediator reports; available is what the ledger actually received
        expect(delivered!.args.value).to.equal(value)
        expect(delivered!.args.available).to.equal(bridged[0])
        expect(delivered!.args.toRecipient).to.equal(toRecipient)
        expect(delivered!.args.partner).to.equal(partnerPayout.address)
        expect(await fresh.owed(USDC, collector)).to.equal(gibsFee)
        expect(await fresh.owed(USDC, partnerPayout)).to.equal(partnerFee)
        expect(await fresh.totalOwed(USDC)).to.equal(gibsFee + partnerFee)
        expect((await usdc.balanceOf(recipient)) - before).to.equal(toRecipient)
        expect(await usdc.balanceOf(freshAddress)).to.equal(gibsFee + partnerFee)
    })

    it('relays native PLS through the WPLS bridge mediator', async () => {
        const amount = 1_000_000n * 10n ** 18n
        const wplsBridge = new ethers.Contract(WPLS_MEDIATOR, mediatorAbi, hre.ethers.provider)
        console.log(`      WPLS registered on the WPLS bridge: ${await wplsBridge.isTokenRegistered(WPLS)}`)
        const tx = await ledger.connect(user).relayNative(
            WPLS_MEDIATOR,
            recipient.address,
            '0x',
            { feeRateE18: 3n * 10n ** 15n, partner: hre.ethers.ZeroAddress, partnerRateE18: 0n },
            { value: amount },
        )
        const receipt = await tx.wait()
        console.log(`      relayNative gas on the fork: ${receipt.gasUsed}`)
        const gibsFee = (amount * 30n) / 10_000n
        const events = bridgingEvents(receipt, WPLS_MEDIATOR)
        expect(events.length).to.equal(1)
        expect(events[0].args.token).to.equal(WPLS)
        const sent = amount - gibsFee
        expect(events[0].args.value).to.equal(sent - (sent * MEDIATOR_FEE) / 10_000n)
        expect(await ledger.owed(WPLS, collector)).to.equal(gibsFee)
    })

    it('unwraps WPLS to PLS for an inbound delivery from the WPLS bridge mediator', async () => {
        const value = 2_000_000n * 10n ** 18n
        const mediator = await impersonate(WPLS_MEDIATOR)
        const wpls = new ethers.Contract(WPLS, tokenAbi, user)
        await wpls.deposit({ value })
        await wpls.transfer(await ledger.getAddress(), value)
        const before = await hre.ethers.provider.getBalance(recipient)
        await ledger.connect(mediator).onTokenBridged(WPLS, value, instruction(recipient.address, { unwrap: true }))
        expect((await hre.ethers.provider.getBalance(recipient)) - before).to.equal(value - (value * 30n) / 10_000n)
    })
})
