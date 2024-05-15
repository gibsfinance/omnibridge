// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface ILegacyERC20 {
    function approve(address spender, uint256 amount) external; // returns (bool);
}
