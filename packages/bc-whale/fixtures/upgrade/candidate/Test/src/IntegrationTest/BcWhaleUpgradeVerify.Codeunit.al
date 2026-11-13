namespace BcWhale.Validation.IntegrationTest;

using BcWhale.Validation.Data;

/// <summary>Verifies preserved seed data and upgrade-codeunit execution.</summary>
/// <remarks>Never seeds or repairs missing data; an empty or fresh install must fail.</remarks>
codeunit 50210 BcWhaleUpgradeVerify
{
    Access = Internal;
    Subtype = Test;
    TestPermissions = Disabled;
    Permissions = tabledata BcWhaleUpgradeEntry = r;

    var
        RowCountErr: Label 'Expected exactly two original seed rows, found %1.', Comment = '%1 = actual row count.';

    /// <summary>Fails unless both original rows survived and were upgraded.</summary>
    [Test]
    procedure VerifyPreservedData()
    var
        Entry: Record BcWhaleUpgradeEntry;
    begin
        if Entry.Count() <> 2 then
            Error(RowCountErr, Entry.Count());
        Entry.Get(1);
        Entry.TestField(OriginalValue, 21);
        Entry.TestField(MigratedValue, 42);
        Entry.TestField(UpgradeApplied, true);
        Entry.Get(2);
        Entry.TestField(OriginalValue, 34);
        Entry.TestField(MigratedValue, 68);
        Entry.TestField(UpgradeApplied, true);
    end;
}
