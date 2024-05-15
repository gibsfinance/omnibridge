// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IAMB } from "./IAMB.sol";

interface IBasicAMBMediator {
  function bridgeContract() external view returns (IAMB);
}
