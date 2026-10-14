// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IERC20Receiver} from "../interfaces/IERC20Receiver.sol";

/**
 * @title MockHomeMediator
 * @dev A small stand in for a home mediator, used in tests of HomeFeeLedger.
 * `deliver` behaves like BasicOmnibridge: it moves tokens, then makes a low level callback and ignores failure.
 * `relayTokensAndCall` pulls tokens and records what it was given.
 */
contract MockHomeMediator {
    event TokensBridgingInitiated(
        address indexed token,
        address indexed sender,
        uint256 value,
        address receiver,
        bytes data
    );

    /// @dev Result of the last callback, for tests to read.
    bool public lastCallbackSucceeded;

    /**
     * @dev Transfers `transferred` tokens to `recipient` then calls `onTokenBridged` with `value`.
     * The two amounts differ in tests of a short delivery.
     * @param token the token to move. This contract must hold it.
     * @param recipient the account to pay and call.
     * @param transferred how many tokens to move.
     * @param value the value told to the callback.
     * @param data the callback data.
     */
    function deliver(address token, address recipient, uint256 transferred, uint256 value, bytes calldata data)
        external
    {
        IERC20(token).transfer(recipient, transferred);
        (lastCallbackSucceeded,) =
            recipient.call(abi.encodeWithSelector(IERC20Receiver.onTokenBridged.selector, token, value, data));
    }

    /**
     * @dev Pulls `value` tokens from the caller and emits an event, like the real mediator does.
     */
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data) external {
        IERC20(token).transferFrom(msg.sender, address(this), value);
        emit TokensBridgingInitiated(token, msg.sender, value, receiver, data);
    }
}
