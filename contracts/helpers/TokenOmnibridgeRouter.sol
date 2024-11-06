// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { ReentrancyV2 } from "./ReentrancyV2.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBasicAMBMediator } from "../interfaces/IBasicAMBMediator.sol";
import { IBasicForeignAMB } from "../interfaces/IBasicForeignAMB.sol";
import { IBridgeValidators } from "../interfaces/IBridgeValidators.sol";
import { IOmnibridge } from "../interfaces/IOmnibridge.sol";
import { IWETH as IWNative } from "../interfaces/IWETH.sol";

import { AddressHelper } from "../libraries/AddressHelper.sol";
import { Bytes } from "../libraries/Bytes.sol";

import { OwnableModule } from "../upgradeable_contracts/modules/OwnableModule.sol";
import { Claimable } from "../upgradeable_contracts/Claimable.sol";
import { StorageSlot } from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @title TokenOmnibridgeRouter
 * @dev Omnibridge extension for processing tokens that are not otherwise
 * delivered automatically because of foreign omnibridge settings
 */
contract TokenOmnibridgeRouter is OwnableModule, Claimable, ReentrancyV2 {
    using SafeERC20 for IERC20;
    bool public immutable EIP1559_ENABLED;
    IOmnibridge public immutable bridge;
    IWNative public immutable WNative;
    address public validatorsFilter;
    mapping(address => bool) public isValidator;

    error NotPayable();

    bytes32 public constant RUNNER_SLOT = keccak256(abi.encode("omnibridgerouter.runner"));

    /**
     * @dev Initializes this contract.
     * @param _bridge address of the HomeOmnibridge/ForeignOmnibridge contract.
     * @param _wNative address of the WNative token used for wrapping/unwrapping native coins (e.g. WETH/WBNB/WXDAI).
     * @param _owner address of the contract owner.
     */
    constructor(
        IOmnibridge _bridge,
        IWNative _wNative,
        address _owner,
        bool _EIP1559_ENABLED
    ) OwnableModule(_owner) {
        bridge = _bridge;
        WNative = _wNative;
        _wNative.approve(address(_bridge), type(uint256).max);
        validatorsFilter = address(this);
        EIP1559_ENABLED = _EIP1559_ENABLED;
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
        // a list of up to 256 flags for modifying how the contract handles tokens
        // 0th index is to use the limit as the fee amount
        // 1st index is to unwrap the tokens
        // 2nd is to ask the system to not include the priority fee
        // 3rd is to use the multiplier as a factor of total tokens
        // if a base fee is available it will only use that
        uint256 settings;
        uint256 limit;
        uint256 multiplier;
    }

    /**
     * @dev Bridged callback function used for unwrapping received tokens.
     * Can only be called by the associated Omnibridge contract.
     * @param _token bridged token contract address, should be WNative.
     * @param _value amount of bridged/received tokens.
     * @param _data extra data passed alongside with relayTokensAndCall
     * on the other side of the bridge. Should contain coins receiver address.
     */
    function onTokenBridged(
        address _token,
        uint256 _value,
        bytes memory _data
    ) external payable virtual nonReentrant {
        require(msg.sender == address(bridge));

        if (_data.length == 20) {
            // handling legacy WNative -> Native
            require(_token == address(WNative));
            WNative.withdraw(_value);
            AddressHelper.safeSendValue(payable(Bytes.bytesToAddress(_data)), _value);
        } else {
            FeeDirector memory feeDirector = abi.decode(_data, (FeeDirector));
            // setting at the 0th slot from the right is a signal to unwrap the tokens
            bool toNative = feeDirector.settings << 254 >> 255 == 1 && address(WNative) == _token;
            // handling WNative -> Native
            if (toNative && _token == address(WNative)) {
                WNative.withdraw(_value);
            } else {
                uint256 balance = IERC20(_token).balanceOf(address(this));
                if (balance < _value) {
                    // this covers the case of tax / reflection tokens
                    // where the amount bridged is less than the amount received by this router
                    _value = balance;
                }
            }
            uint256 runner = StorageSlot.getUint256Slot(RUNNER_SLOT).value;
            uint256 fees;
            uint256 toRecipient = _value;
            if (runner > 0) {
                // setting at the 1st slot from the right is a signal to use the limit as the fixed fee
                (fees, toRecipient) = _feeInfo(toNative, _value, runner, feeDirector);
            }
            if (toRecipient > 0) {
                _distribute(toNative, _token, feeDirector.recipient, toRecipient);
            }
            if (fees > 0) {
                _distribute(toNative, _token, address(uint160(runner >> 96)), fees);
            }
        }
    }

    function _distribute(bool native, address token, address recipient, uint256 amount) internal {
        if (native) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) {
                revert NotPayable();
            }
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

    function _feeInfo(
        bool toNative, uint256 _value, uint256 runner,
        FeeDirector memory feeDirector
    ) internal view returns(uint256 fees, uint256 toRecipient) {
        // use the limit as the fee
        if (feeDirector.settings << 255 >> 255 == 1) {
            fees = feeDirector.limit;
        } else if (feeDirector.settings << 252 >> 255 == 1) {
            fees = (_value * feeDirector.multiplier) / 1 ether;
        } else {
            // a runner has been named (does not have to match sender)
            uint256 gasUsed = uint256(uint96(runner)) - gasleft();
            // extra 50k added for 2x transfer handling + 10%
            // to cover profit motive + risk compensation
            uint256 baselineFee = _baseFee((feeDirector.settings << 253 >> 255) == 1);
            fees = ((gasUsed + (
                // this is an unwrap, different costs for tokens vs native
                toNative ? 50_000 : 100_000
            )) * feeDirector.multiplier * baselineFee) / 1 ether;
            // fees must not be greater than limit
            fees = fees > feeDirector.limit ? feeDirector.limit : fees;
        }
        // fees must not be greater than value
        fees = fees > _value ? _value : fees;
        toRecipient = _value - fees;
    }

    function feeInfo(
        bool toNative, uint256 _value, uint256 runner,
        FeeDirector calldata feeDirector
    ) external view returns(uint256, uint256) {
        return _feeInfo(toNative, _value, runner, feeDirector);
    }

    function baseFee(bool excludePriority) external view returns(uint256) {
        return _baseFee(excludePriority);
    }

    function _baseFee(bool excludePriority) internal view returns(uint256) {
        return EIP1559_ENABLED && excludePriority ? block.basefee : tx.gasprice;
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
    ) external payable nonReentrantUint256(RUNNER_SLOT, uint256(uint96(gasleft())) | (uint256(uint160(runner)) << 96)) {
        if (!IBridgeValidators(validatorsFilter).isValidator(runner)) {
            revert NotPayable();
        }
        IBasicForeignAMB(address(IBasicAMBMediator(address(bridge)).bridgeContract()))
            .safeExecuteSignaturesWithAutoGasLimit(_data, _signatures);
    }
    /**
     * updates the filter to any contract.
     * for future use case, this is the bridge's validator contract
     */
    function setValidatorsFilter(address _validatorsFilter) external payable onlyOwner {
        // if this doesn't fail we are at least guaranteed that it has the method
        IBridgeValidators(_validatorsFilter).isValidator(address(0));
        validatorsFilter = _validatorsFilter;
    }
    /** mev protection management */
    function setValidatorStatus(address _validator, bool _isValidator) external payable onlyOwner {
        isValidator[_validator] = _isValidator;
    }
}
