// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface IInterestReceiver {
    function onInterestReceived(address _token) external;
}
