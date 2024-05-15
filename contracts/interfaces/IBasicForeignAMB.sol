// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IBridgeValidators } from "./IBridgeValidators.sol";

interface IBasicForeignAMB {
    function safeExecuteSignaturesWithAutoGasLimit(bytes calldata _data, bytes calldata _signatures) external;

    function validatorContract() external view returns (IBridgeValidators);

    function relayTokens(address _receiver, uint256 _amount) external;
}
