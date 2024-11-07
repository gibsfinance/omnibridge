// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "../interfaces/IOmnibridge.sol";
import { IWETH as IWNative } from "../interfaces/IWETH.sol";
import "../libraries/AddressHelper.sol";
import "../libraries/Bytes.sol";
import "../upgradeable_contracts/modules/OwnableModule.sol";
import "../upgradeable_contracts/Claimable.sol";

/**
 * @title WPLSOmnibridgeRouter
 * @dev Omnibridge extension for processing native and wrapped native assets.
 * Intended to work with WETH/WBNB/WXDAI/WPLS tokens, see:
 *   https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
 *   https://bscscan.com/address/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
 *   https://blockscout.com/poa/xdai/address/0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d
 */
contract WPLSOmnibridgeRouter is OwnableModule, Claimable {
    IOmnibridge public immutable bridge;
    IWNative public immutable wNative;

    /**
     * @dev Initializes this contract.
     * @param _bridge address of the HomeOmnibridge/ForeignOmnibridge contract.
     * @param _wNative address of the WNative token used for wrapping/unwrapping native coins
     * @param _owner address of the contract owner.
     */
    constructor(
        IOmnibridge _bridge,
        IWNative _wNative,
        address _owner
    ) OwnableModule(_owner) {
        bridge = _bridge;
        wNative = _wNative;
        _wNative.approve(address(_bridge), type(uint256).max);
    }

    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * Call msg.sender will receive assets on the other side of the bridge.
     */
    function wrapAndRelayTokens() external payable {
        wrapAndRelayTokens(msg.sender);
    }

    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * @param _receiver bridged assets receiver on the other side of the bridge.
     */
    function wrapAndRelayTokens(address _receiver) public payable {
        wNative.deposit{ value: msg.value }();
        bridge.relayTokens(address(wNative), _receiver, msg.value);
    }

    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * @param _receiver bridged assets receiver on the other side of the bridge.
     */
    function wrapAndRelayTokensAndCall(address _receiver, bytes memory _data) public payable {
        wNative.deposit{ value: msg.value }();
        bridge.relayTokensAndCall(address(wNative), _receiver, msg.value, _data);
    }

    /**
     * @dev Bridged callback function used for unwrapping received tokens.
     * Can only be called by the associated Omnibridge contract.
     * @param _token bridged token contract address, should be WNative.
     * @param _value amount of bridged/received tokens.
     * @param _data extra data passed alongside with relayTokensAndCall on the other side of the bridge.
     * Should contain coins receiver address.
     */
    function onTokenBridged(
        address _token,
        uint256 _value,
        bytes memory _data
    ) external payable virtual {
        require(_token == address(wNative));
        require(msg.sender == address(bridge));
        require(_data.length == 20);

        wNative.withdraw(_value);

        AddressHelper.safeSendValue(payable(Bytes.bytesToAddress(_data)), _value);
    }

    /**
     * @dev Claims stuck coins/tokens.
     * Only contract owner can call this method.
     * @param _token address of claimed token contract, address(0) for native coins.
     * @param _to address of tokens receiver
     */
    function claimTokens(address _token, address _to) external onlyOwner {
        claimValues(_token, _to);
    }

    /**
     * @dev Native tokens receive function.
     * Should be only called from the WNative contract when withdrawing native coins. Will revert otherwise.
     */
    receive() external payable {
        require(msg.sender == address(wNative));
    }
}
