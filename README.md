# Omnibridge Smart Contracts

[![Join the chat at https://gitter.im/poanetwork/poa-bridge](https://badges.gitter.im/poanetwork/poa-bridge.svg)](https://gitter.im/poanetwork/poa-bridge?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)
[![Build Status](https://github.com/poanetwork/omnibridge/workflows/omnibridge-contracts/badge.svg?branch=master)](https://github.com/poanetwork/omnibridge/workflows/omnibridge-contracts/badge.svg?branch=master)

These contracts provide the core functionality for the Omnibridge AMB extension.

## License

[![License: GPL v3.0](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.

### History

forked from [omnibridge](https://github.com/omni/omnibridge)

used contracts from [tokenbridge-contracts](https://github.com/omni/tokenbridge-contracts)

### Deployments

testnets

```sh
bun hardhat --network pulsechainV4 deploy-tokenomnibridgerouter \
  --w-native 0x70499adEBB11Efd915E3b69E700c331778628707 \
  --bridge 0x6B08a50865aDeCe6e3869D9AfbB316d0a0436B6c
bun hardhat --network sepolia deploy-tokenomnibridgerouter \
  --w-native 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9 \
  --bridge 0x546e37DAA15cdb82fd1a717E5dEEa4AF08D4349A
# delivery-enabled only
npx hardhat --network sepolia set-validator --add \
  --address 0xDcd4D88552c86114b2ca029F7F8d4e1a7951d051 \
  --router
```

mainnets

pulsechain

```sh
bun hardhat --network pulsechain deploy-tokenomnibridgerouter \
  --w-native 0xA1077a294dDE1B09bB078844df40758a5D0f9a27 \
  --bridge 0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef
bun hardhat --network mainnet deploy-tokenomnibridgerouter \
  --w-native 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --bridge 0x1715a3E4A142d8b698131108995174F37aEBA10D
# delivery-enabled only
npx hardhat --network mainnet set-validator --add \
  --address 0x5ECfE77502317F3677f23C3b8Ab17929ACE3D74E \
  --router
```

tokensex

```sh
bun hardhat --network pulsechain deploy-tokenomnibridgerouter \
  --w-native 0xA1077a294dDE1B09bB078844df40758a5D0f9a27 \
  --bridge 0xf1DFc63e10fF01b8c3d307529b47AefaD2154C0e
bun hardhat --network bsc deploy-wbnbomnibridgerouter \
  --w-native 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c \
  --bridge 0xb4005881e81a6ecd2c1f75d58e8e41f28d59c6b1
# delivery-enabled only
npx hardhat --network mainnet set-validator --add \
  --address 0xc3c3d5d3ba946a2eb3906878ebe187418b0b524e \
  --router
```
