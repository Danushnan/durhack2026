import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2] / 'backend'))
from test_journeys import setup,evidence,read,NOW
from test_checkout_journey import checkout_action,checkout_events
results=[]
for kind in ['basket','checkout','decline']:
 a,t,s,v=setup(None if kind=='basket' else checkout_action().model_copy(update={'checkout':'failed'} if kind=='decline' else {}))
 t.ingest(evidence(a) if kind=='basket' else checkout_events(a,**({'status':402,'payment_status':402} if kind=='decline' else {})),NOW+2)
 r=read(s,v,a,t); r['collecting']=False
 body=a.model_dump(mode='json',exclude_none=True)
 keys=('action_id','mutation_id','refresh_id','mutation','refresh') if kind=='basket' else ('kind','action_id','request_id','checkout','basket_cleared')
 results.append({'action':{k:body[k] for k in keys if k in body},'result':r})
print(json.dumps(results))
