// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockLedgerToken
 * @dev A test token that can misbehave: take a fee on transfer, return false, or revert.
 * Failing modes apply only to transfers made by `misbehavingSender`, so a test can fund a contract first.
 */
contract MockLedgerToken is ERC20 {
    /// @dev How `transfer` behaves.
    enum TransferMode {
        Normal,
        ReturnFalse,
        Revert
    }

    /// @notice The fee taken on every transfer, in basis points.
    uint256 public feeBasisPoints;
    /// @notice How `transfer` behaves for `misbehavingSender`.
    TransferMode public transferMode;
    /// @notice The only sender that `transferMode` applies to.
    address public misbehavingSender;

    constructor() ERC20("Mock", "MOCK") {}

    /**
     * @dev Mints tokens to any account.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @dev Sets the fee burnt on every transfer.
     */
    function setFeeBasisPoints(uint256 value) external {
        feeBasisPoints = value;
    }

    /**
     * @dev Sets how `transfer` behaves, and for which sender.
     */
    function setTransferMode(TransferMode mode, address sender) external {
        transferMode = mode;
        misbehavingSender = sender;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (msg.sender == misbehavingSender && transferMode == TransferMode.ReturnFalse) return false;
        if (msg.sender == misbehavingSender && transferMode == TransferMode.Revert) revert("transfer disabled");
        return super.transfer(to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeBasisPoints == 0 || from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = (value * feeBasisPoints) / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
