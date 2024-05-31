// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { Reentrancy } from "./Reentrancy.sol";

import { IBasicAMBMediator } from "../interfaces/IBasicAMBMediator.sol";
import { IBasicForeignAMB } from "../interfaces/IBasicForeignAMB.sol";
import { IBridgeValidators } from "../interfaces/IBridgeValidators.sol";
import { IOmnibridge } from "../interfaces/IOmnibridge.sol";
import { IWNative } from "../interfaces/IWNative.sol";

import { AddressHelper } from "../libraries/AddressHelper.sol";
import { Bytes } from "../libraries/Bytes.sol";

import { OwnableModule } from "../upgradeable_contracts/modules/OwnableModule.sol";
import { Claimable } from "../upgradeable_contracts/Claimable.sol";

/**
 * @title WBNBOmnibridgeRouter
 * @dev Omnibridge extension for processing native and wrapped native assets.
 * Intended to work with WETH/WBNB/WXDAI tokens, see:
 *   https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
 *   https://bscscan.com/address/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
 *   https://blockscout.com/poa/xdai/address/0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d
 */
contract WBNBOmnibridgeRouter is OwnableModule, Claimable, Reentrancy {
    IOmnibridge public immutable bridge;
    IWNative public immutable WNative;
    address public validatorsFilter;
    mapping(address => bool) public isValidator;

    error NotPayable();

    /**
     * @dev Initializes this contract.
     * @param _bridge address of the HomeOmnibridge/ForeignOmnibridge contract.
     * @param _wNative address of the WNative token used for wrapping/unwrapping native coins (e.g. WETH/WBNB/WXDAI).
     * @param _owner address of the contract owner.
     */
    constructor(
        IOmnibridge _bridge,
        IWNative _wNative,
        address _owner
    ) OwnableModule(_owner) {
        bridge = _bridge;
        WNative = _wNative;
        _wNative.approve(address(_bridge), type(uint256).max);
        validatorsFilter = address(this);
    }

    /**
     * @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
     * Call msg.sender will receive assets on the other side of the bridge.
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
        WNative.deposit{ value: msg.value }();
        bridge.relayTokensAndCall(address(WNative), _receiver, msg.value, _data);
    }

    struct FeeDirector {
        address recipient;
        bool fixedFee;
        uint256 limit;
        uint256 multiplier;
    }

    /**
     * @dev Bridged callback function used for unwrapping received tokens.
     * Can only be called by the associated Omnibridge contract.
     * @param _token bridged token contract address, should be WETH.
     * @param _value amount of bridged/received tokens.
     * @param _data extra data passed alongside with relayTokensAndCall on the other side of the bridge.
     * Should contain coins receiver address.
     */
    function onTokenBridged(
        address _token,
        uint256 _value,
        bytes memory _data
    ) external payable virtual nonReentrant {
        require(_token == address(WNative));
        require(msg.sender == address(bridge));
        WNative.withdraw(_value);

        if (_data.length == 20) {
            AddressHelper.safeSendValue(payable(Bytes.bytesToAddress(_data)), _value);
        } else {
            uint256 runner = reentrantUint256;
            uint256 fees;
            uint256 toRecipient = _value;
            FeeDirector memory feeDirector = abi.decode(_data, (FeeDirector));
            if (runner > 0) {
                if (feeDirector.fixedFee) {
                    fees = feeDirector.limit;
                } else {
                    // a runner has been named (does not have to match sender)
                    uint256 gasUsed = uint256(uint96(runner)) - gasleft();
                    // extra 50k added for 2x transfer handling + 10%
                    // to cover profit motive + risk compensation
                    fees = ((gasUsed + 50_000) * feeDirector.multiplier * tx.gasprice) / 1 ether;
                    // fees must not be greater than limit
                    fees = fees > feeDirector.limit ? feeDirector.limit : fees;
                }
                // fees must not be greater than value
                fees = fees > _value ? _value : fees;
                toRecipient = _value - fees;
            }
            if (toRecipient > 0) {
                (bool success, ) = feeDirector.recipient.call{value: toRecipient}("");
                if (!success) {
                    revert NotPayable();
                }
            }
            if (fees > 0) {
                (bool success, ) = address(uint160(runner >> 96)).call{value: fees}("");
                if (!success) {
                    revert NotPayable();
                }
            }
        }
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
     * @dev Ether receive function.
     * Should be only called from the WNative contract when withdrawing native coins. Will revert otherwise.
     */
    receive() external payable {
        require(msg.sender == address(WNative));
    }
    /**
     * @dev Validates provided signatures and relays a given message. Passes all available gas for the execution.
     * The message is not allowed to fail. The whole tx will be revered if message fails.
     * @param runner the validator you would like to attribute this method call to
     * @param _data bytes to be relayed
     * @param _signatures bytes blob with signatures to be validated
     * @notice that the sender does not matter, so this method could be called via
     * multicall for more efficient gas savings and still attribute tokens to the validator appropriately
     */
    function safeExecuteSignaturesWithAutoGasLimit(
        address runner,
        bytes calldata _data,
        bytes calldata _signatures
    ) external payable nonReentrantUint256(uint256(uint96(gasleft())) | (uint256(uint160(runner)) << 96)) {
        if (!IBridgeValidators(validatorsFilter).isValidator(runner)) {
            revert NotPayable();
        }
        IBasicForeignAMB(address(IBasicAMBMediator(address(bridge)).bridgeContract()))
            .safeExecuteSignaturesWithAutoGasLimit(_data, _signatures);
    }
    function setValidatorsFilter(address _validatorsFilter) external payable onlyOwner {
        // if this doesn't fail we are at least guaranteed that it has the method
        IBridgeValidators(_validatorsFilter).isValidator(address(0));
        validatorsFilter = _validatorsFilter;
    }
    function setValidatorStatus(address _validator, bool _isValidator) external payable onlyOwner {
        isValidator[_validator] = _isValidator;
    }
}
