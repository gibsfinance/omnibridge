import { expect } from 'chai'
import { getAddress } from 'ethers'
import {
  PULSECHAIN_MAINNET_CHAIN_ID,
  PULSECHAIN_TESTNET_V4_CHAIN_ID,
  resolveDeployPlan,
} from '../../tasks/homefeeledger-deploy-plan'

// Pure unit tests: the plan is built without a node, so these run offline.
const APPROVED = getAddress('0xAF2ce0189f46f5663715b0b9ED2a10eA924AB9B0')
const TESTNET_MEDIATOR = getAddress('0x6B08a50865aDeCe6e3869D9AfbB316d0a0436B6c')
const TESTNET_WNATIVE = getAddress('0x70499adEBB11Efd915E3b69E700c331778628707')
const MAINNET_MEDIATOR = getAddress('0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef')
const MAINNET_WPLS = getAddress('0xA1077a294dDE1B09bB078844df40758a5D0f9a27')
const OTHER = '0x00000000000000000000000000000000000000aa'

const noArguments = {}

describe('resolveDeployPlan', () => {
    describe('testnet v4 (943)', () => {
        it('uses the testnet defaults without any flag', () => {
            const plan = resolveDeployPlan({ chainId: PULSECHAIN_TESTNET_V4_CHAIN_ID, allowMainnet: false, taskArguments: noArguments })
            expect(plan).to.deep.equal({
                chainId: 943n,
                networkName: 'PulseChain testnet v4',
                mediators: [TESTNET_MEDIATOR],
                wrappedNative: TESTNET_WNATIVE,
                gibsCollector: APPROVED,
                rescueRecipient: APPROVED,
            })
        })
        it('refuses the mainnet flag, because it would mean the wrong chain was reached', () => {
            expect(() => resolveDeployPlan({ chainId: 943n, allowMainnet: true, taskArguments: noArguments }))
                .to.throw(/applies only to chain 369/)
        })
        it('lets a given argument override its default', () => {
            const plan = resolveDeployPlan({
                chainId: 943n,
                allowMainnet: false,
                taskArguments: { collector: OTHER, rescue: OTHER, mediators: ` ${OTHER} , ${TESTNET_MEDIATOR}` },
            })
            expect(plan.gibsCollector).to.equal(getAddress(OTHER))
            expect(plan.rescueRecipient).to.equal(getAddress(OTHER))
            expect(plan.mediators).to.deep.equal([getAddress(OTHER), TESTNET_MEDIATOR])
            expect(plan.wrappedNative).to.equal(TESTNET_WNATIVE)
        })
    })

    describe('mainnet (369)', () => {
        it('refuses without the flag', () => {
            expect(() => resolveDeployPlan({ chainId: PULSECHAIN_MAINNET_CHAIN_ID, allowMainnet: false, taskArguments: noArguments }))
                .to.throw(/Pass --allow-mainnet/)
        })
        it('accepts with the flag and uses the mainnet defaults', () => {
            const plan = resolveDeployPlan({ chainId: 369n, allowMainnet: true, taskArguments: noArguments })
            expect(plan).to.deep.equal({
                chainId: 369n,
                networkName: 'PulseChain mainnet',
                mediators: [MAINNET_MEDIATOR],
                wrappedNative: MAINNET_WPLS,
                gibsCollector: APPROVED,
                rescueRecipient: APPROVED,
            })
        })
        it('does not fall back to the testnet defaults', () => {
            const plan = resolveDeployPlan({ chainId: 369n, allowMainnet: true, taskArguments: noArguments })
            expect(plan.mediators).to.not.include(TESTNET_MEDIATOR)
            expect(plan.wrappedNative).to.not.equal(TESTNET_WNATIVE)
        })
    })

    describe('unknown chains', () => {
        it('refuses every chain without a plan, even with the mainnet flag', () => {
            for (const chainId of [1n, 56n, 1337n, 11155111n, 0n]) {
                expect(() => resolveDeployPlan({ chainId, allowMainnet: true, taskArguments: noArguments }))
                    .to.throw(/no deploy plan for chain/)
                expect(() => resolveDeployPlan({ chainId, allowMainnet: false, taskArguments: noArguments }))
                    .to.throw(/no deploy plan for chain/)
            }
        })
    })

    describe('argument checks', () => {
        it('refuses an address that is not one', () => {
            expect(() => resolveDeployPlan({ chainId: 943n, allowMainnet: false, taskArguments: { collector: 'not-an-address' } }))
                .to.throw(/collector is not an address/)
        })
        it('refuses the zero address for the collector, the rescue recipient and the wrapped token', () => {
            const zero = '0x0000000000000000000000000000000000000000'
            expect(() => resolveDeployPlan({ chainId: 943n, allowMainnet: false, taskArguments: { collector: zero } }))
                .to.throw(/collector is the zero address/)
            expect(() => resolveDeployPlan({ chainId: 943n, allowMainnet: false, taskArguments: { rescue: zero } }))
                .to.throw(/rescue is the zero address/)
            expect(() => resolveDeployPlan({ chainId: 943n, allowMainnet: false, taskArguments: { wnative: zero } }))
                .to.throw(/wnative is the zero address/)
        })
        it('refuses an empty mediator list', () => {
            expect(() => resolveDeployPlan({ chainId: 943n, allowMainnet: false, taskArguments: { mediators: ' , ' } }))
                .to.throw(/at least one mediator/)
        })
    })
})
