// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title GasLimitedCaller
/// @notice Test helper only. Its runtime bytecode is placed at the bridge address on a
/// local fork so that calls it makes pass the mediator's `onlyMediator` check, while the
/// gas forwarded to the mediator call is capped to a known value.
/// @dev The mediator's `onlyMediator` modifier also reads `bridgeContract().messageSender()`
/// and compares it against the mediator's own `mediatorContractOnOtherSide()`. Once this
/// code replaces the real bridge, that read lands here, so this contract stores and
/// answers that one value to keep the check passing.
contract GasLimitedCaller {
    address public messageSender;
    bytes32 public messageId;

    function setMessageSender(address sender) external {
        messageSender = sender;
    }

    function setMessageId(bytes32 id) external {
        messageId = id;
    }

    function relay(
        address target,
        bytes calldata data,
        uint256 gas
    ) external returns (bool ok, uint256 gasLeftAfter) {
        (ok, ) = target.call{gas: gas}(data);
        gasLeftAfter = gasleft();
    }
}

/// @title RevertPlain
/// @notice Test recipient. Its callback reverts with no return data.
contract RevertPlain {
    function onTokenBridged(address, uint256, bytes calldata) external pure {
        revert();
    }
}

/// @title RevertBomb
/// @notice Test recipient. Its callback reverts with about one mebibyte of return data,
/// to test whether the mediator's unused `.call` return copy burns the forwarded gas.
contract RevertBomb {
    function onTokenBridged(address, uint256, bytes calldata) external pure {
        assembly {
            revert(0, 0x100000)
        }
    }
}

/// @title GasEaterThenRevert
/// @notice Test recipient. Its callback spins until almost all forwarded gas is gone,
/// then reverts.
contract GasEaterThenRevert {
    function onTokenBridged(address, uint256, bytes calldata) external view {
        assembly {
            for {

            } gt(gas(), 2000) {

            } {}
            revert(0, 0)
        }
    }
}
