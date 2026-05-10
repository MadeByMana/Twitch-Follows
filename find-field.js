
async function test() {
  const login = "ninja";
  const fields = [
    'follows(first: 5)',
    'following(first: 5)',
    'followings(first: 5)',
    'followedChannels(first: 5)',
    'followedUsers(first: 5)',
    'followingConnection(first: 5)',
    'followedChannelsConnection(first: 5)',
    'followRelationship(first: 5)',
    'followsBy(first: 5)',
    'followChannelsConnection(first: 5)'
  ];

  for (const f of fields) {
    try {
      const response = await fetch('http://localhost:3000/api/twitch-gql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `
            query {
              user(login: "${login}") {
                ${f} {
                  totalCount
                }
              }
            }
          `
        })
      });
      const data = await response.json();
      const fieldName = f.split('(')[0];
      if (data.data?.user && data.data.user[fieldName]) {
        console.log(`SUCCESS: ${f}`);
      } else if (data.errors) {
        console.log(`FAILED: ${f} - ${data.errors[0].message}`);
      }
    } catch (e) {
      console.log(`EXCEPTION: ${f} - ${e.message}`);
    }
  }
}

test();
