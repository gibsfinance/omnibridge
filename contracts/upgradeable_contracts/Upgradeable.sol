// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "../interfaces/IUpgradeabilityOwnerStorage.sol";

contract Upgradeable {
    /**
     * @dev Throws if called by any account other than the upgradeability owner.
     */
    modifier onlyIfUpgradeabilityOwner() {
        _onlyIfUpgradeabilityOwner();
        _;
    }

    /**
     * @dev Internal function for reducing onlyIfUpgradeabilityOwner modifier bytecode overhead.
     */
    function _onlyIfUpgradeabilityOwner() internal view {
        require(msg.sender == IUpgradeabilityOwnerStorage(address(this)).upgradeabilityOwner());
    }
}
