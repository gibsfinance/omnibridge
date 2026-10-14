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
// the fee, in basis points, that the real mediators keep on a home to foreign transfer (observed on the fork)
const MEDIATOR_FEE = 30n
const ETHEREUM_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const mediatorAbi = [
    'function isTokenRegistered(address) view returns (bool)',
    'function nativeTokenAddress(address) view returns (address)',
    'event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)',
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
        ledger = await factory.deploy([MAIN_MEDIATOR, WPLS_MEDIATOR], WPLS, collector, signers[0], 30)
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
        await ledger.connect(partnerPayout).registerPartner(partnerPayout, 50)
        await usdc.approve(ledger, amount)
        const supplyBefore = await usdc.totalSupply()
        const tx = await ledger.connect(user).relay(MAIN_MEDIATOR, USDC, amount, recipient.address, '0x', 1, 80)
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

    it('splits an inbound delivery from the real mediator address', async () => {
        const value = 500n * 10n ** 6n
        const mediator = await impersonate(MAIN_MEDIATOR)
        // what the real mediator does: mint to the recipient, then call back and ignore the result
        await usdc.connect(mediator).mint(await ledger.getAddress(), value)
        const before = await usdc.balanceOf(recipient)
        const owedBefore = await ledger.owed(USDC, collector)
        const tx = await ledger.connect(mediator).onTokenBridged(USDC, value, instruction(recipient.address, 1n, 80n))
        const receipt = await tx.wait()
        console.log(`      inbound split gas on the fork: ${receipt.gasUsed}`)
        const gibsFee = (value * 30n) / 10_000n
        const partnerFee = (value * 50n) / 10_000n
        expect((await usdc.balanceOf(recipient)) - before).to.equal(value - gibsFee - partnerFee)
        expect((await ledger.owed(USDC, collector)) - owedBefore).to.equal(gibsFee)
    })

    it('relays native PLS through the WPLS bridge mediator', async () => {
        const amount = 1_000_000n * 10n ** 18n
        const wplsBridge = new ethers.Contract(WPLS_MEDIATOR, mediatorAbi, hre.ethers.provider)
        console.log(`      WPLS registered on the WPLS bridge: ${await wplsBridge.isTokenRegistered(WPLS)}`)
        const tx = await ledger.connect(user).relayNative(WPLS_MEDIATOR, recipient.address, '0x', 0, 30, { value: amount })
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
        await ledger.connect(mediator).onTokenBridged(WPLS, value, instruction(recipient.address, 0n, 30n, true))
        expect((await hre.ethers.provider.getBalance(recipient)) - before).to.equal(value - (value * 30n) / 10_000n)
    })
})
