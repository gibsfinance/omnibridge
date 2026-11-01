// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/**
 * @title MockGasBurner
 * @dev A recipient whose receive function burns every unit of gas it is given,
 * then fails. Used to test that a native payout cannot starve the rest of a delivery.
 */
contract MockGasBurner {
    receive() external payable {
        assembly {
            for {} 1 {} {}
        }
    }
}

/**
 * @title MockWalletImplementation
 * @dev The logic half of {MockProxyWallet}. Its receive function emits an event,
 * as the Safe singleton's receive function does.
 */
contract MockWalletImplementation {
    /// @notice Emitted when the wallet receives native coin.
    event WalletReceived(address indexed sender, uint256 value);

    receive() external payable {
        emit WalletReceived(msg.sender, msg.value);
    }
}

/**
 * @title MockProxyWallet
 * @dev A smart-contract wallet shaped like a Safe proxy: it reads its
 * implementation from storage slot 0 and delegates every call to it, so a plain
 * native transfer pays a cold storage read, a cold delegate call and an event.
 */
contract MockProxyWallet {
    /// @dev The implementation address, kept in slot 0 as the Safe proxy keeps its singleton.
    address internal implementation;

    constructor(address implementationAddress) {
        implementation = implementationAddress;
    }

    fallback() external payable {
        assembly {
            let target := sload(0)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(success) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }
}
