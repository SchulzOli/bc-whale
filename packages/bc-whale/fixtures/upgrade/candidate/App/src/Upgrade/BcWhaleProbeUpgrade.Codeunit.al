namespace BcWhale.Validation.Upgrade;

using BcWhale.Validation.Data;

/// <summary>Transforms preexisting synthetic data during an application upgrade.</summary>
/// <remarks>Does not seed, delete or recreate records; empty data cannot prove an upgrade.</remarks>
codeunit 50201 BcWhaleProbeUpgrade
{
    Access = Internal;
    Subtype = Upgrade;
    Permissions = tabledata BcWhaleUpgradeEntry = rm;

    trigger OnUpgradePerCompany()
    var
        Entry: Record BcWhaleUpgradeEntry;
    begin
        if Entry.FindSet(true) then
            repeat
                if not Entry.UpgradeApplied then begin
                    Entry.MigratedValue := Entry.OriginalValue * 2;
                    Entry.UpgradeApplied := true;
                    Entry.Modify(false);
                end;
            until Entry.Next() = 0;
    end;
}
