namespace BcWhale.Validation.Data;

/// <summary>Grants access to synthetic upgrade validation data.</summary>
/// <remarks>Only assign in a disposable validation environment.</remarks>
permissionset 50200 BcWhaleUpgradeProbe
{
    Assignable = true;
    Caption = 'BC Whale upgrade validation';
    Permissions = tabledata BcWhaleUpgradeEntry = RIMD,
                  table BcWhaleUpgradeEntry = X;
}
