// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IOmnibridge, IOmnibridgeExtra } from "../interfaces/IOmnibridge.sol";
import { IWETH as IWNative } from "../interfaces/IWETH.sol";

import { TokenOmnibridgeBase } from "./TokenOmnibridgeBase.sol";

/**
 * @title TokenOmnibridgeRouter
 * @dev Omnibridge extension for processing tokens that are not otherwise
 * delivered automatically because of foreign omnibridge settings
 */
contract TokenOmnibridgeRouter is TokenOmnibridgeBase {
    constructor(address _bridge, IWNative _wNative, address _owner) TokenOmnibridgeBase(_bridge, _wNative, _owner, true) {}
    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * Call msg.sender will receive assets on the other side of the bridge.
     * @notice only available for non-"extra" bridges
     */
    function wrapAndRelayTokens() external payable {
        _relayTokensAndCall(msg.sender, "");
    }

    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * @param _receiver bridged assets receiver on the other side of the bridge.
     */
    function wrapAndRelayTokens(address _receiver) external payable {
        _relayTokensAndCall(_receiver, "");
    }
    /**
     * a convenience method for relaying tokens to a corresponding network
     * @param _receiver the receiving contract on the other network
     * @param _data the encoded data that should be passed to `onTokenBridged` on the other network
     */
    function relayTokensAndCall(address _receiver, bytes calldata _data) external payable {
        _relayTokensAndCall(_receiver, _data);
    }
    function _relayTokensAndCall(address _receiver, bytes memory _data) internal {
        wNative.deposit{ value: msg.value }();
        IOmnibridge(bridge).relayTokensAndCall(address(wNative), _receiver, msg.value, _data);
    }
    // appends a sender origin to the calldata
    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * @param _receiver bridged assets receiver on the other side of the bridge.
     */
    function wrapAndRelayTokens(address _receiver, address _senderOrigin) external payable {
        _relayTokensAndCallWithExtra(_receiver, "", _senderOrigin);
    }
    /**
     * a convenience method for relaying tokens to a corresponding network
     * @param _receiver the receiving contract on the other network
     * @param _data the encoded data that should be passed to `onTokenBridged` on the other network
     */
    function relayTokensAndCall(address _receiver, bytes calldata _data, address _senderOrigin) external payable {
        _relayTokensAndCallWithExtra(_receiver, _data, _senderOrigin);
    }
    function _relayTokensAndCallWithExtra(address _receiver, bytes memory _data, address _senderOrigin) internal {
        wNative.deposit{ value: msg.value }();
        IOmnibridgeExtra(bridge).relayTokensAndCall(address(wNative), _receiver, msg.value, _data, _senderOrigin);
    }
}
