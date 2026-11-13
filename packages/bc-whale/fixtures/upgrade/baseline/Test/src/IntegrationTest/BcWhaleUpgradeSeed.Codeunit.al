namespace BcWhale.Validation.IntegrationTest;

using BcWhale.Validation.Data;

/// <summary>Commits deterministic seed rows for a subsequent application upgrade.</summary>
/// <remarks>Requires a disposable company and permits commits; never deletes existing rows.</remarks>
codeunit 50210 BcWhaleUpgradeSeed
{
    Access = Internal;
    Subtype = Test;
    TestPermissions = Disabled;
    Permissions = tabledata BcWhaleUpgradeEntry = ri;

    var
        SeedExistsErr: Label 'Upgrade seed data already exists. Use a fresh validation company.', Comment = 'Prevents overwriting persistent upgrade evidence.';

    /// <summary>Persists two rows that candidate verification must find unchanged.</summary>
    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure SeedPersistentRows()
    var
        Entry: Record BcWhaleUpgradeEntry;
    begin
        if not Entry.IsEmpty() then
            Error(SeedExistsErr);
        Entry.Init();
        Entry.EntryNo := 1;
        Entry.OriginalValue := 21;
        Entry.Insert(false);
        Entry.Init();
        Entry.EntryNo := 2;
        Entry.OriginalValue := 34;
        Entry.Insert(false);
        Commit();
    end;
}
