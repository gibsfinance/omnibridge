[![Join the chat at https://gitter.im/poanetwork/poa-bridge](https://badges.gitter.im/poanetwork/poa-bridge.svg)](https://gitter.im/poanetwork/poa-bridge?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)
[![Build Status](https://github.com/poanetwork/omnibridge/workflows/omnibridge-contracts/badge.svg?branch=master)](https://github.com/poanetwork/omnibridge/workflows/omnibridge-contracts/badge.svg?branch=master)

# Omnibridge Smart Contracts
These contracts provide the core functionality for the Omnibridge AMB extension.

## License

[![License: GPL v3.0](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.

### History

forked from https://github.com/omni/omnibridge

used contracts from https://github.com/omni/tokenbridge-contracts

### Deployments

```sh
bun hardhat --network pulsechainV4 deploy-tokenomnibridgerouter \
  --w-native 0x70499adEBB11Efd915E3b69E700c331778628707 \
  --bridge 0x6B08a50865aDeCe6e3869D9AfbB316d0a0436B6c
bun hardhat --network sepolia deploy-tokenomnibridgerouter \
  --w-native 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9 \
  --bridge 0x546e37DAA15cdb82fd1a717E5dEEa4AF08D4349A
```
