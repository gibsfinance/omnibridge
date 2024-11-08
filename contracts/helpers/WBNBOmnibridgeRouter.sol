// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IOmnibridgeExtra } from "../interfaces/IOmnibridge.sol";
import { IWETH as IWNative } from "../interfaces/IWETH.sol";

import { TokenOmnibridgeBase } from "./TokenOmnibridgeBase.sol";

/**
 * @title WBNBOmnibridgeRouter
 * @dev Omnibridge extension for processing tokens that are not otherwise
 * delivered automatically because of foreign omnibridge settings
 */
contract WBNBOmnibridgeRouter is TokenOmnibridgeBase {
    constructor(address _bridge, IWNative _wNative, address _owner) TokenOmnibridgeBase(_bridge, _wNative, _owner, false) {}
    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * Call msg.sender will receive assets on the other side of the bridge.
     */
    function wrapAndRelayTokens(address senderOrigin) external payable {
        _relayTokensAndCall(msg.sender, "", senderOrigin);
    }

    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * @param _receiver bridged assets receiver on the other side of the bridge.
     */
    function wrapAndRelayTokens(address _receiver, address senderOrigin) external payable {
        _relayTokensAndCall(_receiver, "", senderOrigin);
    }
    /**
     * a convenience method for relaying tokens to a corresponding network
     * @param _receiver the receiving contract on the other network
     * @param _data the encoded data that should be passed to `onTokenBridged` on the other network
     */
    function relayTokensAndCall(address _receiver, bytes calldata _data, address senderOrigin) external payable {
        _relayTokensAndCall(_receiver, _data, senderOrigin);
    }
    function _relayTokensAndCall(address _receiver, bytes memory _data, address senderOrigin) internal {
        wNative.deposit{ value: msg.value }();
        IOmnibridgeExtra(bridge).relayTokensAndCall(address(wNative), _receiver, msg.value, _data, senderOrigin);
    }

}
