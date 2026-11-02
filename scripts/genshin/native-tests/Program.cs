using System;
using System.Threading.Tasks;
using BetterGenshinImpact.GameTask.AutoFight.Model;

static void Check(bool condition,string message) { if(!condition)throw new Exception(message); }
Check(PartyRecoveryScope.Current is null,"scope leaked before task");
using(var scope=new PartyRecoveryScope(true))
{
    Check(scope.RecordRevivePrompt(1000)==0,"unattributed prompt must not condemn next avatar");
    scope.RecordSwitch(2,1000);
    Check(scope.RecordRevivePrompt(1300)==2&&scope.IsDefeated(2)&&!scope.IsDefeated(1),"only selected dead slot should be skipped");
    scope.RecordSwitch(3,2000);scope.ConfirmSwitch();
    Check(scope.RecordRevivePrompt(2300)==0&&!scope.IsDefeated(3),"successful switch must clear pending association");
    scope.RecordSwitch(4,3000);
    Check(scope.RecordRevivePrompt(7000)==0&&!scope.IsDefeated(4),"stale switch must not mark a teammate dead");
    await Task.Run(()=>Check(PartyRecoveryScope.Current==scope&&scope.IsDefeated(2),"combat worker must inherit scope"));
    using(var disabled=new PartyRecoveryScope(false))
    {
        disabled.RecordSwitch(1,8000);disabled.RecordRevivePrompt(8100);
        Check(!disabled.IsDefeated(1),"opt-out must preserve original behavior");
    }
    Check(PartyRecoveryScope.Current==scope,"nested task must restore parent scope");
}
Check(PartyRecoveryScope.Current is null,"scope leaked after task");
using(var nextFight=new PartyRecoveryScope(true))Check(!nextFight.IsDefeated(2),"new fight must re-observe rather than retain old deaths");
Console.WriteLine("Recovery policy tests passed: attribution, stale prompts, successful switching, worker scope, opt-out, cleanup, new fight.");
