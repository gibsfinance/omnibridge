// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

contract AMBMock {
    event MockedEvent(bytes32 indexed messageId, address executor, uint8 dataType, bytes data, uint256 gas);

    address public messageSender;
    uint256 public immutable maxGasPerTx;
    bytes32 public transactionHash;
    bytes32 public messageId;
    uint256 public nonce;
    uint256 public messageSourceChainId;
    mapping(bytes32 => bool) public messageCallStatus;
    mapping(bytes32 => bool) public relayedMessages;
    mapping(bytes32 => address) public failedMessageSender;
    mapping(bytes32 => address) public failedMessageReceiver;
    mapping(bytes32 => bytes32) public failedMessageDataHash;

    address public validatorContract;

    constructor(address _validatorContract) {
        maxGasPerTx = 1000000;
        validatorContract = _validatorContract;
    }

    function executeMessageCall(
        address _contract,
        address _sender,
        bytes calldata _data,
        bytes32 _messageId,
        uint256 _gas
    ) external {
        _executeMessageCall(_contract, _sender, _data, _messageId, _gas);
    }

    /**
     * @dev Stands in for the foreign bridge's "safe" delivery: it reads the message
     * identifier, sender, executor and gas limit from the message header, runs the
     * executor call with that gas limit, and reverts unless the executor call
     * succeeded. Like the real bridge, it only sees the executor's result, so a
     * failure the executor swallows (a mediator's receiver callback) still passes.
     * Signatures are ignored. A message is relayed at most once.
     */
    function safeExecuteSignaturesWithAutoGasLimit(bytes calldata _message, bytes calldata) external {
        bytes32 id = bytes32(_message[0:32]);
        address sender = address(bytes20(_message[32:52]));
        address executor = address(bytes20(_message[52:72]));
        uint256 gasLimit = uint32(bytes4(_message[72:76]));
        uint256 innerStart = 79 + uint8(_message[76]) + uint8(_message[77]);
        require(!relayedMessages[id], "already relayed");
        bool status = _executeMessageCall(executor, sender, _message[innerStart:], id, gasLimit);
        require(status, "message call failed");
    }

    function _executeMessageCall(
        address _contract,
        address _sender,
        bytes calldata _data,
        bytes32 _messageId,
        uint256 _gas
    ) internal returns (bool status) {
        messageSender = _sender;
        messageId = _messageId;
        transactionHash = _messageId;
        messageSourceChainId = 1337;
        // the real foreign bridge records the message as relayed before it calls
        // the executor, so recovery can tell a relayed message from a pending one
        relayedMessages[_messageId] = true;
        (status, ) = _contract.call{ gas: _gas }(_data);
        messageSender = address(0);
        messageId = bytes32(0);
        transactionHash = bytes32(0);
        messageSourceChainId = 0;

        messageCallStatus[_messageId] = status;
        if (!status) {
            failedMessageDataHash[_messageId] = keccak256(_data);
            failedMessageReceiver[_messageId] = _contract;
            failedMessageSender[_messageId] = _sender;
        }
    }

    function requireToPassMessage(
        address _contract,
        bytes calldata _data,
        uint256 _gas
    ) external returns (bytes32) {
        return _sendMessage(_contract, _data, _gas, 0x00);
    }

    function requireToConfirmMessage(
        address _contract,
        bytes calldata _data,
        uint256 _gas
    ) external returns (bytes32) {
        return _sendMessage(_contract, _data, _gas, 0x80);
    }

    function _sendMessage(
        address _contract,
        bytes calldata _data,
        uint256 _gas,
        uint256 _dataType
    ) internal returns (bytes32) {
        require(messageId == bytes32(0));
        bytes32 bridgeId =
            keccak256(abi.encodePacked(uint16(1337), address(this))) &
                0x00000000ffffffffffffffffffffffffffffffffffffffff0000000000000000;

        bytes32 _messageId = bytes32(uint256(0x11223344 << 224)) | bridgeId | bytes32(nonce);
        nonce += 1;

        emit MockedEvent(_messageId, _contract, uint8(_dataType), _data, _gas);
        return _messageId;
    }

    function sourceChainId() external pure returns (uint256) {
        return 1337;
    }
}
