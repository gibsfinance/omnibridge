import type { HardhatUserConfig } from 'hardhat/config'
import 'solidity-coverage'
import '@nomicfoundation/hardhat-toolbox'
import '@solidstate/hardhat-4byte-uploader'
import '@nomicfoundation/hardhat-verify'

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
    compilers: [
      {
        version: '0.8.24',
        settings: {
          evmVersion: 'cancun',
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: false
        },
      },
    ],
  },
  sourcify: {
    enabled: true,
  },
  networks: {
    hardhat: {
      accounts: {
        // this is the mnemonic used when the `--deterministic` flag is passed to ganache
        mnemonic: process.env.MNEMONIC ?? 'myth like bonus scare over problem client lizard pioneer submit female collect',
        accountsBalance: (10n ** 28n).toString(),
      },
      initialBaseFeePerGas: 0,
      chainId: 1337,
      enableTransientStorage: true,
      allowUnlimitedContractSize: true,
      ...(process.env.CHAIN
        ? {
          forking:
            process.env.CHAIN === 'mainnet'
              ? {
                url: 'https://rpc-ethereum.g4mm4.io',
                blockNumber: 22_517_700,
              }
              : process.env.CHAIN === 'bsc'
                ? {
                  url: process.env.RPC_56 || 'https://binance.llamarpc.com',
                  blockNumber: 40_615_914,
                }
                : {
                  url: 'https://badurl',
                  blockNumber: 1,
                },
        }
        : {}),
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
    sepolia: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: process.env.RPC_11155111 || 'https://ethereum-sepolia-rpc.publicnode.com',
    },
    pulsechainV4: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: process.env.RPC_943 || 'https://rpc.v4.testnet.pulsechain.com',
    },
    pulsechain: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: process.env.RPC_369 || 'https://rpc.pulsechain.com',
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
      sepolia: process.env.ETHERSCAN_API_KEY || '',
      bsc: process.env.BSCSCAN_API_KEY || '',
      pulsechainV4: 'abc',
      pulsechain: 'abc',
    },
    customChains: [
      {
        network: 'pulsechainV4',
        chainId: 943,
        urls: {
          apiURL: 'https://api.scan.v4.testnet.pulsechain.com/api',
          browserURL: 'https://scan.v4.testnet.pulsechain.com/#',
        },
      },
      {
        network: 'pulsechain',
        chainId: 369,
        urls: {
          apiURL: 'https://api.scan.pulsechain.com/api',
          browserURL: 'https://scan.pulsechain.com',
        },
      },
    ],
  },
  fourByteUploader: {
    runOnCompile: true,
  },
}

export default config
