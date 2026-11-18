import { getAddress, ZeroAddress } from 'ethers'

/** PulseChain testnet v4. The chain id the deploy task may deploy to without any extra flag. */
export const PULSECHAIN_TESTNET_V4_CHAIN_ID = 943n
/** PulseChain mainnet. Deploying here needs the `--allow-mainnet` flag. */
export const PULSECHAIN_MAINNET_CHAIN_ID = 369n

/** The account the owner approved as gibs collector, rescue recipient and deployer. */
export const APPROVED_ACCOUNT = '0xAF2ce0189f46f5663715b0b9ED2a10eA924AB9B0'

/**
 * The arguments the deploy task reads from the command line. An unset value takes the chain default.
 * Addresses are comma separated for `mediators`.
 */
export type DeployTaskArguments = {
  mediators?: string
  wnative?: string
  collector?: string
  rescue?: string
}

/**
 * Everything the constructor needs, checked and checksummed. Building it does not touch a node.
 * @param chainId the chain the deploy goes to.
 * @param networkName a human name for the chain, for the deploy log.
 * @param mediators the home mediators that may deliver and relay.
 * @param wrappedNative the wrapped native token (WPLS).
 * @param gibsCollector the account credited with gibs fees.
 * @param rescueRecipient the only account that receives rescued tokens.
 */
export type DeployPlan = {
  chainId: bigint
  networkName: string
  mediators: string[]
  wrappedNative: string
  gibsCollector: string
  rescueRecipient: string
}

/** The defaults for one chain, and whether the chain counts as mainnet. */
type ChainDefaults = {
  networkName: string
  isMainnet: boolean
  mediators: string[]
  wrappedNative: string
  gibsCollector: string
  rescueRecipient: string
}

const TESTNET_V4_DEFAULTS: ChainDefaults = {
  networkName: 'PulseChain testnet v4',
  isMainnet: false,
  // the v4 testnet erc20 home mediator, the one that delivers tokens bridged from Sepolia
  mediators: ['0x6B08a50865aDeCe6e3869D9AfbB316d0a0436B6c'],
  // wrapped PLS on the v4 testnet (`nativeAssetOut` of bridge-sdk)
  wrappedNative: '0x70499adEBB11Efd915E3b69E700c331778628707',
  gibsCollector: APPROVED_ACCOUNT,
  rescueRecipient: APPROVED_ACCOUNT,
}

const MAINNET_DEFAULTS: ChainDefaults = {
  networkName: 'PulseChain mainnet',
  isMainnet: true,
  // the PulseChain home mediator for the Ethereum route
  mediators: ['0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef'],
  // WPLS on PulseChain mainnet
  wrappedNative: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  gibsCollector: APPROVED_ACCOUNT,
  rescueRecipient: APPROVED_ACCOUNT,
}

/**
 * The defaults for a chain, or undefined for a chain the task does not know.
 * @param chainId the chain id the node reports.
 * @returns the defaults, or undefined when the chain is unknown.
 */
export function chainDefaultsFor(chainId: bigint): ChainDefaults | undefined {
  if (chainId === PULSECHAIN_TESTNET_V4_CHAIN_ID) return TESTNET_V4_DEFAULTS
  if (chainId === PULSECHAIN_MAINNET_CHAIN_ID) return MAINNET_DEFAULTS
  return undefined
}

/**
 * Parses one address argument. Throws with the argument name when it is not an address or is the zero address.
 * @param name the argument name, for the error message.
 * @param value the address text.
 * @returns the checksummed address.
 */
function parseAddress(name: string, value: string): string {
  let address: string
  try {
    address = getAddress(value.trim())
  } catch {
    throw new Error(`${name} is not an address: ${value}`)
  }
  if (address === ZeroAddress) throw new Error(`${name} is the zero address`)
  return address
}

/**
 * Parses the comma separated mediator list. Throws when no mediator is given.
 * @param value the comma separated addresses.
 * @returns the checksummed mediator addresses, in the order given.
 */
function parseMediators(value: string): string[] {
  const mediators = value
    .split(',')
    .map((mediator) => mediator.trim())
    .filter((mediator) => mediator.length > 0)
    .map((mediator) => parseAddress('mediators', mediator))
  if (mediators.length === 0) throw new Error('at least one mediator is required')
  return mediators
}

/**
 * Resolves what the deploy task will send. Refuses a chain with no plan, refuses mainnet without the flag,
 * and refuses the flag on the testnet, so that a wrong chain never gets a deploy by accident.
 * Each argument that is given overrides the chain default. Nothing is sent by this function.
 * @param options.chainId the chain id the node reports.
 * @param options.allowMainnet true only when the operator passed `--allow-mainnet`.
 * @param options.taskArguments the values given on the command line.
 * @returns the checked deploy plan.
 */
export function resolveDeployPlan(options: {
  chainId: bigint
  allowMainnet: boolean
  taskArguments: DeployTaskArguments
}): DeployPlan {
  const { chainId, allowMainnet, taskArguments } = options
  const defaults = chainDefaultsFor(chainId)
  if (!defaults) {
    throw new Error(
      `no deploy plan for chain ${chainId}. The task deploys to ${PULSECHAIN_TESTNET_V4_CHAIN_ID} (testnet v4) or ${PULSECHAIN_MAINNET_CHAIN_ID} (mainnet)`,
    )
  }
  if (defaults.isMainnet && !allowMainnet) {
    throw new Error(`chain ${chainId} is PulseChain mainnet. Pass --allow-mainnet to deploy there`)
  }
  if (!defaults.isMainnet && allowMainnet) {
    throw new Error(`--allow-mainnet applies only to chain ${PULSECHAIN_MAINNET_CHAIN_ID}, the node reports ${chainId}`)
  }
  return {
    chainId,
    networkName: defaults.networkName,
    mediators: parseMediators(taskArguments.mediators ?? defaults.mediators.join(',')),
    wrappedNative: parseAddress('wnative', taskArguments.wnative ?? defaults.wrappedNative),
    gibsCollector: parseAddress('collector', taskArguments.collector ?? defaults.gibsCollector),
    rescueRecipient: parseAddress('rescue', taskArguments.rescue ?? defaults.rescueRecipient),
  }
}
