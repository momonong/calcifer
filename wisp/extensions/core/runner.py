"""Private task owner; invoked by the approved GUI action, never by a model tool."""
import importlib.util
import json
from pathlib import Path
import sys

if __name__ == '__main__':
    package = Path(__file__).parent
    spec = importlib.util.spec_from_file_location('_wisp_worker', package/'__init__.py', submodule_search_locations=[str(package)])
    module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
    from _wisp_worker.service import Service
    from _wisp_worker.executor import run_task
    from _wisp_worker.verification import run_verification
    service = Service(sys.argv[1])
    try:
        runtime = json.loads(sys.argv[4])
        if runtime.get('mode') == 'verify':
            run_verification(service, sys.argv[2], int(sys.argv[3]))
        else:
            run_task(service, sys.argv[2], int(sys.argv[3]), runtime)
    except Exception as error:
        service.store.append(sys.argv[2], 'runner-start-error', {'code':type(error).__name__})
        task = service.store.load(sys.argv[2])
        if task['status'] in ('RUNNING','WAITING_APPROVAL','VERIFYING','CANCEL_REQUESTED'):
            service.terminated(sys.argv[2], int(sys.argv[3]), confirmed=False)
        sys.exit(1)
