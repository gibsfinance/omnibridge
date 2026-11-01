// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferToken
 * @dev A token that burns a share of every transfer between two holders, the way
 * a tax or reflection token does. Minting is free of the fee. Used to test what
 * the router pays when a delivery arrives short.
 */
contract MockFeeOnTransferToken is ERC20 {
    /// @notice The share of each transfer that is burned, in basis points.
    uint256 public immutable transferFeeBasisPoints;

    /// @param feeBasisPoints the share of each transfer to burn, in basis points
    constructor(uint256 feeBasisPoints) ERC20("Fee Token", "FEE") {
        transferFeeBasisPoints = feeBasisPoints;
    }

    /// @dev Mints `value` tokens to `to`, with no fee. Test only.
    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    /// @dev Burns the fee share of a transfer between two holders, then moves the rest.
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * transferFeeBasisPoints) / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
