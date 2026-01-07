import { getJobCounts, getRecentJobs } from '@/lib/db'

export const dynamic = 'force-dynamic'

export default function Dashboard() {
  const counts = getJobCounts()
  const jobs = getRecentJobs(100)

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Queue Dashboard</h1>

      <div className="flex gap-4 mb-6">
        <div className="bg-yellow-100 p-3 rounded">Waiting: {counts.waiting}</div>
        <div className="bg-blue-100 p-3 rounded">Active: {counts.active}</div>
        <div className="bg-green-100 p-3 rounded">Completed: {counts.completed}</div>
        <div className="bg-red-100 p-3 rounded">Failed: {counts.failed}</div>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">ID</th>
            <th className="p-2">Type</th>
            <th className="p-2">Status</th>
            <th className="p-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr key={job.id} className="border-b">
              <td className="p-2 font-mono text-sm">{job.id.slice(0, 8)}</td>
              <td className="p-2">{job.type}</td>
              <td className="p-2">
                <span className={
                  job.status === 'completed' ? 'text-green-600' :
                  job.status === 'failed' ? 'text-red-600' :
                  job.status === 'active' ? 'text-blue-600' :
                  'text-yellow-600'
                }>
                  {job.status}
                </span>
              </td>
              <td className="p-2">{job.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
