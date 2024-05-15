// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "../interfaces/IERC20Receiver.sol";

contract TokenReceiver is IERC20Receiver {
    address public token;
    address public from;
    uint256 public value;
    bytes public data;

    function onTokenBridged(
        address _token,
        uint256 _value,
        bytes memory _data
    ) external override {
        token = _token;
        from = msg.sender;
        value = _value;
        data = _data;
    }
}
