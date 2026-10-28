// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ReentrancyV2} from "./ReentrancyV2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBasicAMBMediator} from "../interfaces/IBasicAMBMediator.sol";
import {IBasicForeignAMB} from "../interfaces/IBasicForeignAMB.sol";
import {IBridgeValidators} from "../interfaces/IBridgeValidators.sol";
import {IOmnibridge} from "../interfaces/IOmnibridge.sol";
import {IWETH as IWNative} from "../interfaces/IWETH.sol";

import {AddressHelper} from "../libraries/AddressHelper.sol";
import {Bytes} from "../libraries/Bytes.sol";

import {OwnableModule} from "../upgradeable_contracts/modules/OwnableModule.sol";
import {Claimable} from "../upgradeable_contracts/Claimable.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @dev The read surface of the foreign Arbitrary Message Bridge that recovery needs.
 *
 * The router never writes to the bridge. It reads four facts about a message:
 * which message is executing right now, whether a given message was relayed,
 * whether the recipient call for that message reported success, and which
 * contract holds the validator set. The deployed foreign Arbitrary Message
 * Bridge exposes all four.
 */
interface IForeignArbitraryMessageBridge {
    function messageId() external view returns (bytes32);

    function messageCallStatus(bytes32 messageId) external view returns (bool);

    function relayedMessages(bytes32 messageId) external view returns (bool);

    function validatorContract() external view returns (address);
}

/**
 * @title TokenOmnibridgeBase
 * @dev Omnibridge extension for processing tokens that are not otherwise
 * delivered automatically because of foreign omnibridge settings.
 *
 * RECOVERY OF A STRANDED DELIVERY. The bridge hands tokens to this router and
 * then calls {onTokenBridged}. The mediator that makes that call throws away
 * its result (a bare low-level call), so a delivery that runs out of gas inside
 * {onTokenBridged} leaves the tokens in this router while the bridge records
 * the message as delivered. Nothing a router can do inside {onTokenBridged}
 * makes the mediator report that failure, so the router cannot force the bridge
 * transaction to revert. The router therefore offers {recover}: anyone can
 * finish a stranded delivery afterwards by replaying the signed message. The
 * recipient receives the tokens with no delivery tip, because no one delivered
 * the message.
 */
contract TokenOmnibridgeBase is OwnableModule, Claimable, ReentrancyV2 {
    using SafeERC20 for IERC20;

    bool public immutable EIP1559_ENABLED;
    address public immutable bridge;
    IWNative public immutable wNative;
    address public validatorsFilter;
    mapping(address => bool) public isValidator;

    /**
     * @dev Records every message this router has already paid out, keyed by the
     * Arbitrary Message Bridge message identifier. A normal delivery records its
     * own identifier before it pays, and {recover} records the identifier it
     * replays, so a message can be paid at most once by either path.
     */
    mapping(bytes32 => bool) public processed;

    error NotPayable();
    error WrongExecutor();
    error MessageNotRelayed();
    error MessageNotDelivered();
    error AlreadyProcessed();
    error NotForThisRouter();
    error MalformedMessage();
    error UnsupportedSelector();
    error NotEnoughSignatures();
    error InvalidSignature();
    error SignerNotValidator();
    error DuplicateSignature();

    /**
     * @dev Emitted when {recover} finishes a stranded delivery.
     * @param messageId the Arbitrary Message Bridge message identifier that was recovered
     * @param token the token paid out
     * @param recipient the address paid
     * @param value the amount paid, after the fee-on-transfer balance clamp
     */
    event DeliveryRecovered(bytes32 indexed messageId, address indexed token, address indexed recipient, uint256 value);

    /**
     * @dev The selectors of the two mediator callbacks that deliver to a
     * receiver and carry extra data. Both share the same argument layout
     * (token, recipient, value, data), so {recover} decodes them the same way.
     */
    bytes4 private constant HANDLE_BRIDGED_SELECTOR = bytes4(keccak256("handleBridgedTokensAndCall(address,address,uint256,bytes)"));
    bytes4 private constant HANDLE_NATIVE_SELECTOR = bytes4(keccak256("handleNativeTokensAndCall(address,address,uint256,bytes)"));

    bytes32 public constant RUNNER_SLOT = keccak256(abi.encode("omnibridgerouter.runner"));

    /**
     * @dev Initializes this contract.
     * @param _bridge address of the HomeOmnibridge/ForeignOmnibridge contract.
     * @param _wNative address of the WNative token used for wrapping/unwrapping native coins (e.g. WETH/WBNB/WXDAI).
     * @param _owner address of the contract owner.
     */
    constructor(address _bridge, IWNative _wNative, address _owner, bool _EIP1559_ENABLED) OwnableModule(_owner) {
        bridge = _bridge;
        wNative = _wNative;
        _wNative.approve(address(_bridge), type(uint256).max);
        validatorsFilter = address(this);
        EIP1559_ENABLED = _EIP1559_ENABLED;
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
     * @param _token bridged token contract address, should be wNative.
     * @param _value amount of bridged/received tokens.
     * @param _data extra data passed alongside with relayTokensAndCall
     * on the other side of the bridge. Should contain coins receiver address.
     */
    function onTokenBridged(address _token, uint256 _value, bytes memory _data) external payable virtual nonReentrant {
        require(msg.sender == address(bridge));
        // Record the message that is executing now, so a later {recover} can
        // never pay this message a second time. The read is tolerant: a bridge
        // that does not expose the identifier (only reachable in tests) reads as
        // zero and records nothing, while the live bridge always returns the
        // executing identifier, so a real delivery is always recorded. A delivery
        // that later reverts unwinds this write along with everything else.
        _recordProcessedMessage();
        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance < _value) {
            // this covers the case of tax / reflection tokens
            // where the amount bridged is less than the amount received by this router
            _value = balance;
        }
        if (_data.length == 20) {
            // handling legacy wNative -> Native
            require(_token == address(wNative));
            wNative.withdraw(_value);
            _distribute(true, address(wNative), Bytes.bytesToAddress(_data), _value);
        } else {
            FeeDirector memory feeDirector = abi.decode(_data, (FeeDirector));
            // setting at the 0th slot from the right is a signal to unwrap the tokens
            bool toNative = feeDirector.settings << 254 >> 255 == 1 && address(wNative) == _token;
            // handling wNative -> Native
            if (toNative && _token == address(wNative)) {
                wNative.withdraw(_value);
            }
            uint256 runner = StorageSlot.getUint256Slot(RUNNER_SLOT).value;
            uint256 fees;
            uint256 toRecipient = _value;
            if (runner > 1) {
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

    /**
     * @dev Finishes a delivery that stranded in this router, by replaying the
     * signed Arbitrary Message Bridge message. Pays the recipient the full
     * value with no delivery tip, because no one delivered the message.
     *
     * The caller supplies the exact message bytes and the validator signatures,
     * the same pair the bridge accepted. This function trusts nothing the caller
     * asserts about that pair. It confirms the signatures against the live
     * validator set, confirms the bridge actually relayed the message and
     * recorded the recipient call as successful (which is what a stranded
     * delivery looks like, and is false for a message that failed and was
     * refunded on the other chain), confirms the message delivered tokens to
     * THIS router through THIS router's own mediator, and confirms the message
     * has not already been paid. Only then does it pay, and it records the
     * identifier first so the same message cannot be paid twice.
     *
     * @param message the Arbitrary Message Bridge message, exactly as signed
     * @param signatures the validator signatures over that message
     */
    function recover(bytes calldata message, bytes calldata signatures) external nonReentrant {
        _recover(message, signatures);
    }

    /**
     * @dev The recovery body, shared by the public {recover} and by the single
     * delivery entry {safeExecuteSignaturesWithAutoGasLimit}. It follows
     * checks-effects-interactions: it records the message as processed before it
     * moves any tokens, so a re-entrant call for the same message finds it
     * already processed. It takes no reentrancy modifier of its own; both
     * callers hold one.
     */
    function _recover(bytes calldata message, bytes calldata signatures) internal {
        (bytes32 messageIdentifier, address executor, bytes calldata innerCall) = _parseMessage(message);
        // The message must have run through this router's own mediator. The
        // mediator is the only caller {onTokenBridged} accepts, so any message
        // for another mediator or an ordinary transfer cannot be recovered here.
        if (executor != bridge) revert WrongExecutor();

        IForeignArbitraryMessageBridge arbitraryMessageBridge =
            IForeignArbitraryMessageBridge(address(IBasicAMBMediator(bridge).bridgeContract()));

        _verifySignatures(arbitraryMessageBridge.validatorContract(), message, signatures);

        // relayedMessages is set before the recipient call, so it alone does not
        // prove the tokens arrived. messageCallStatus is the mediator's own call
        // result: true for a stranded delivery (the mediator swallows the failed
        // recipient callback and returns success), and false for a message that
        // failed outright and was refunded on the other chain. Both gates together
        // admit only a message whose tokens really reached this router.
        if (!arbitraryMessageBridge.relayedMessages(messageIdentifier)) revert MessageNotRelayed();
        if (!arbitraryMessageBridge.messageCallStatus(messageIdentifier)) revert MessageNotDelivered();
        if (processed[messageIdentifier]) revert AlreadyProcessed();

        (address token, address recipient, uint256 value, bytes memory data) = _decodeHandleCall(innerCall);
        if (recipient != address(this)) revert NotForThisRouter();

        processed[messageIdentifier] = true;

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < value) {
            // same fee-on-transfer clamp the delivery path applies
            value = balance;
        }
        _deliverWithoutFee(token, value, data);
        emit DeliveryRecovered(messageIdentifier, token, recipient, value);
    }

    /**
     * @dev Distributes tokens to a recipient. For a native payout that the
     * recipient refuses, it falls back to delivering the wrapped token rather
     * than reverting, so a recipient that cannot receive the native coin never
     * strands the transfer.
     */
    function _distribute(bool native, address token, address recipient, uint256 amount) internal {
        if (!native) {
            IERC20(token).safeTransfer(recipient, amount);
            return;
        }
        (bool success,) = recipient.call{value: amount}("");
        if (success) {
            return;
        }
        // the recipient cannot receive the native coin: re-wrap and deliver the
        // wrapped token to the same recipient instead of reverting
        wNative.deposit{value: amount}();
        IERC20(address(wNative)).safeTransfer(recipient, amount);
    }

    /**
     * @dev Delivers a message's tokens with no fee, honouring the unwrap flag
     * and the legacy twenty-byte form. Used by {recover}: a recovered message
     * had no deliverer, so it carries no tip.
     */
    function _deliverWithoutFee(address token, uint256 value, bytes memory data) internal {
        if (data.length == 20) {
            require(token == address(wNative));
            wNative.withdraw(value);
            _distribute(true, address(wNative), Bytes.bytesToAddress(data), value);
            return;
        }
        FeeDirector memory feeDirector = abi.decode(data, (FeeDirector));
        bool toNative = feeDirector.settings << 254 >> 255 == 1 && address(wNative) == token;
        if (toNative) {
            wNative.withdraw(value);
        }
        if (value > 0) {
            _distribute(toNative, token, feeDirector.recipient, value);
        }
    }

    function _feeInfo(bool toNative, uint256 _value, uint256 runner, FeeDirector memory feeDirector)
        internal
        view
        returns (uint256 fees, uint256 toRecipient)
    {
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
            fees = (
                (
                    gasUsed
                    // this is an unwrap, different costs for tokens vs native
                    + (toNative ? 50_000 : 100_000)
                ) * feeDirector.multiplier * baselineFee
            ) / 1 ether;
            // fees must not be greater than limit
            fees = fees > feeDirector.limit ? feeDirector.limit : fees;
        }
        // fees must not be greater than value
        fees = fees > _value ? _value : fees;
        toRecipient = _value - fees;
    }

    function feeInfo(bool toNative, uint256 _value, uint256 runner, FeeDirector calldata feeDirector)
        external
        view
        returns (uint256, uint256)
    {
        return _feeInfo(toNative, _value, runner, feeDirector);
    }

    function baseFee(bool excludePriority) external view returns (uint256) {
        return _baseFee(excludePriority);
    }

    function _baseFee(bool excludePriority) internal view returns (uint256) {
        return EIP1559_ENABLED && excludePriority ? block.basefee : tx.gasprice;
    }

    /**
     * @dev Records the message that is executing right now as processed, reading
     * the identifier from this router's mediator's Arbitrary Message Bridge.
     *
     * The read is deliberately tolerant. A bridge that does not expose the
     * identifier (only a test stand-in) returns empty data, which reads as zero
     * and records nothing. The live bridge always sets the identifier before it
     * calls the mediator, and the mediator reads it itself during the callback,
     * so a real delivery always has a non-zero identifier to record.
     */
    function _recordProcessedMessage() internal {
        bytes32 messageIdentifier = _currentMessageId();
        if (messageIdentifier != bytes32(0)) {
            processed[messageIdentifier] = true;
        }
    }

    function _currentMessageId() internal view returns (bytes32) {
        (bool bridgeFound, bytes memory bridgeReturn) =
            address(bridge).staticcall(abi.encodeWithSelector(IBasicAMBMediator.bridgeContract.selector));
        if (!bridgeFound || bridgeReturn.length < 32) {
            return bytes32(0);
        }
        address arbitraryMessageBridge = abi.decode(bridgeReturn, (address));
        if (arbitraryMessageBridge == address(0)) {
            return bytes32(0);
        }
        (bool idFound, bytes memory idReturn) =
            arbitraryMessageBridge.staticcall(abi.encodeWithSelector(IForeignArbitraryMessageBridge.messageId.selector));
        if (!idFound || idReturn.length < 32) {
            return bytes32(0);
        }
        return abi.decode(idReturn, (bytes32));
    }

    /**
     * @dev Unpacks the fields {recover} needs from an Arbitrary Message Bridge
     * message. The layout is fixed: 32 bytes message identifier, 20 bytes
     * sender, 20 bytes executor, 4 bytes gas limit, 1 byte source chain id
     * length, 1 byte destination chain id length, 1 byte data type, then the two
     * chain ids, then the executor's calldata.
     */
    function _parseMessage(bytes calldata message)
        internal
        pure
        returns (bytes32 messageIdentifier, address executor, bytes calldata innerCall)
    {
        if (message.length < 79) revert MalformedMessage();
        assembly {
            messageIdentifier := calldataload(message.offset)
            // executor sits 52 bytes in; load 32 bytes from there and keep the top 20
            executor := shr(96, calldataload(add(message.offset, 52)))
        }
        uint256 sourceChainIdLength = uint8(message[76]);
        uint256 destinationChainIdLength = uint8(message[77]);
        uint256 innerStart = 79 + sourceChainIdLength + destinationChainIdLength;
        if (message.length < innerStart) revert MalformedMessage();
        innerCall = message[innerStart:];
    }

    /**
     * @dev Decodes the mediator callback embedded in a message. Accepts only the
     * two "and call" selectors that carry a fee director, which is exactly the
     * shape this router delivers; anything else is rejected.
     */
    function _decodeHandleCall(bytes calldata innerCall)
        internal
        pure
        returns (address token, address recipient, uint256 value, bytes memory data)
    {
        if (innerCall.length < 4) revert MalformedMessage();
        bytes4 selector = bytes4(innerCall[0:4]);
        if (selector != HANDLE_BRIDGED_SELECTOR && selector != HANDLE_NATIVE_SELECTOR) revert UnsupportedSelector();
        (token, recipient, value, data) = abi.decode(innerCall[4:], (address, address, uint256, bytes));
    }

    /**
     * @dev Reproduces the bridge's own signature check over a message. Reverts
     * unless at least `requiredSignatures` distinct validators signed the
     * message. The signatures blob is one count byte, then that many `v` bytes,
     * then that many 32-byte `r` words, then that many 32-byte `s` words.
     */
    function _verifySignatures(address validatorContract, bytes calldata message, bytes calldata signatures)
        internal
        view
    {
        uint256 requiredSignatures = IBridgeValidators(validatorContract).requiredSignatures();
        if (signatures.length < 1) revert NotEnoughSignatures();
        uint256 count = uint8(signatures[0]);
        if (count < requiredSignatures) revert NotEnoughSignatures();
        if (signatures.length < 1 + count + 64 * count) revert NotEnoughSignatures();

        bytes32 hash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", _uintToString(message.length), message)
        );

        address[] memory seen = new address[](requiredSignatures);
        for (uint256 i = 0; i < requiredSignatures; i++) {
            uint8 v = uint8(signatures[1 + i]);
            bytes32 r;
            bytes32 s;
            uint256 rPosition = 1 + count + 32 * i;
            uint256 sPosition = 1 + count + 32 * count + 32 * i;
            assembly {
                r := calldataload(add(signatures.offset, rPosition))
                s := calldataload(add(signatures.offset, sPosition))
            }
            address recovered = ecrecover(hash, v, r, s);
            if (recovered == address(0)) revert InvalidSignature();
            if (!IBridgeValidators(validatorContract).isValidator(recovered)) revert SignerNotValidator();
            for (uint256 j = 0; j < i; j++) {
                if (seen[j] == recovered) revert DuplicateSignature();
            }
            seen[i] = recovered;
        }
    }

    /// @dev Decimal string of a number, matching the bridge's message hashing.
    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 digits = value;
        uint256 length;
        while (digits != 0) {
            length++;
            digits /= 10;
        }
        bytes memory buffer = new bytes(length);
        while (value != 0) {
            length -= 1;
            buffer[length] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
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
     * Should be only called from the wNative contract when withdrawing native coins. Will revert otherwise.
     */
    receive() external payable {
        require(msg.sender == address(wNative));
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
    function safeExecuteSignaturesWithAutoGasLimit(address runner, bytes calldata _data, bytes calldata _signatures)
        external
        payable
        nonReentrantUint256(RUNNER_SLOT, uint256(uint96(gasleft())) | (uint256(uint160(runner)) << 96))
    {
        // One entry for every situation. A caller (the delivery service, or
        // anyone) always calls this function with the signed message. The branch
        // decides what the message needs:
        //
        //   - If the bridge has already relayed this message, a first delivery
        //     ran. The bridge never relays a message twice, so the only reason
        //     to be here again is that the first delivery stranded. Finish it
        //     with no tip. {_recover} re-checks everything (signatures, the two
        //     bridge flags, that it targeted this router, and that it has not
        //     been paid) and reverts a message that was already completed.
        //
        //   - Otherwise this is a fresh delivery. The runner must be a known
        //     validator (the existing protection against a stranger claiming the
        //     fee), and the message runs through the bridge, which calls back
        //     into {onTokenBridged} with the runner attributed for the fee.
        IForeignArbitraryMessageBridge arbitraryMessageBridge =
            IForeignArbitraryMessageBridge(address(IBasicAMBMediator(bridge).bridgeContract()));
        (bytes32 messageIdentifier,,) = _parseMessage(_data);
        if (arbitraryMessageBridge.relayedMessages(messageIdentifier)) {
            _recover(_data, _signatures);
            return;
        }
        if (!IBridgeValidators(validatorsFilter).isValidator(runner)) {
            revert NotPayable();
        }
        IBasicForeignAMB(address(arbitraryMessageBridge)).safeExecuteSignaturesWithAutoGasLimit(_data, _signatures);
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
    /**
     * mev protection management
     */
    function setValidatorStatus(address _validator, bool _isValidator) external payable onlyOwner {
        isValidator[_validator] = _isValidator;
    }
}
