// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface IBridgeValidators {
    function isValidator(address _validator) external view returns (bool);

    function F_ADDR() external view returns (address);

    function getNextValidator(address _address) external view returns (address);

    function validatorCount() external view returns (uint256);

    function validatorList() external view returns(address[] memory);
}
