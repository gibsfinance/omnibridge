import type { HardhatUserConfig } from 'hardhat/config'
import 'solidity-coverage'
import 'hardhat-tracer'
import '@nomicfoundation/hardhat-toolbox'

import './tasks'

const HARDHAT_NETWORK_MNEMONIC = 'test test test test test test test test test test test junk'

Error.stackTraceLimit = Infinity

const chains = {
  56: {
    hardforkHistory: {
      merge: 17_233_000,
      shanghai: 17_233_001,
      cancun: 17_233_002,
    },
  },
  369: {
    hardforkHistory: {
      merge: 17_233_000,
      shanghai: 17_233_001,
      cancun: 17_233_002,
    },
  },
  943: {
    hardforkHistory: {
      merge: 15_537_394,
      shanghai: 15_537_395,
      cancun: 15_537_396,
    },
  },
  11155111: {
    hardforkHistory: {
      merge: 1_000_000,
      shanghai: 1_000_001,
      cancun: 1_000_002,
    },
  },
  1337: {
    hardforkHistory: {
      merge: 1_000_000,
      shanghai: 1_000_001,
      cancun: 1_000_002,
    },
  },
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{
      version: '0.8.24',
    }],
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  tracer: {
    enabled: true,
  },
  sourcify: {
    enabled: true,
  },
  networks: {
    hardhat: {
      accounts: {
        // this is the mnemonic used when the `--deterministic` flag is passed to ganache
        mnemonic: 'myth like bonus scare over problem client lizard pioneer submit female collect',
        accountsBalance: (10n ** 28n).toString(),
      },
      initialBaseFeePerGas: 0,
      chainId: 1337,
      enableTransientStorage: true,
      allowUnlimitedContractSize: true,
      ...(process.env.CHAIN ? {
        forking: process.env.CHAIN === 'mainnet' ? {
          url: 'https://rpc-ethereum.g4mm4.io',
          blockNumber: 19_926_341,
        } : (
          process.env.CHAIN === 'bsc' ? {
            url: process.env.RPC_56 || 'https://binance.llamarpc.com',
            blockNumber: 40_615_914,
          } : {
            url: 'https://badurl',
            blockNumber: 1,
          }
        ),
      } : {}),
      chains,
    },
    localhardhat: {
      url: process.env.PROVIDER || 'http://localhost:8545',
    },
    mainnet: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: 'https://rpc-ethereum.g4mm4.io',
    },
    bsc: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: process.env.RPC_56 || 'https://binance.llamarpc.com',
    },
  },
  typechain: {
    outDir: 'artifacts/types',
    target: 'ethers-v6',
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || '',
      bsc: process.env.ETHERSCAN_API_KEY || '',
    },
  },
}

export default config
